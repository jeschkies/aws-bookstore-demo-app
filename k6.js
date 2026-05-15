import http from 'k6/http'
import { check, sleep, fail } from 'k6'
import secrets from 'k6/secrets'
import { Endpoint, SignatureV4 } from 'https://jslib.k6.io/aws/0.13.0/signature.js'

export const options = {
  vus: 10,
  duration: '5m',
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<2000'],
  },
}

const REGION = 'us-east-1'
const API_HOST = '8u1bhugda6.execute-api.us-east-1.amazonaws.com'
const API_STAGE = 'prod'
const USER_POOL_ID = 'us-east-1_DQJNX7Em3'
const IDENTITY_POOL_ID = 'us-east-1:761ba0db-4507-4ee9-8977-c98ae08ee90c'
const COGNITO_IDP_URL = `https://cognito-idp.${REGION}.amazonaws.com/`
const COGNITO_IDENTITY_URL = `https://cognito-identity.${REGION}.amazonaws.com/`

function cognitoCall(target, body) {
  const url = target.startsWith('AWSCognitoIdentityProviderService')
    ? COGNITO_IDP_URL
    : COGNITO_IDENTITY_URL
  const res = http.post(url, JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': target,
    },
  })
  if (res.status !== 200) fail(`${target} failed: ${res.status} ${res.body}`)
  return res.json()
}

export async function setup() {
  const clientId = await secrets.get('cognitoclientid')
  const username = await secrets.get('cognitousername')
  const password = await secrets.get('cognitopassword')

  // 1. User Pool: username/password -> IdToken
  const auth = cognitoCall('AWSCognitoIdentityProviderService.InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: clientId,
    AuthParameters: { USERNAME: username, PASSWORD: password },
  })
  const idToken = auth.AuthenticationResult.IdToken
  const logins = { [`cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`]: idToken }

  // 2. Identity Pool: IdToken -> IdentityId
  const { IdentityId } = cognitoCall('AWSCognitoIdentityService.GetId', {
    IdentityPoolId: IDENTITY_POOL_ID,
    Logins: logins,
  })

  // 3. Identity Pool: IdentityId -> temp AWS creds
  const { Credentials } = cognitoCall(
    'AWSCognitoIdentityService.GetCredentialsForIdentity',
    { IdentityId, Logins: logins },
  )

  return {
    accessKeyId: Credentials.AccessKeyId,
    secretAccessKey: Credentials.SecretKey,
    sessionToken: Credentials.SessionToken,
  }
}

export default function (creds) {
  const signer = new SignatureV4({
    service: 'execute-api',
    region: REGION,
    credentials: creds,
    uriEscapePath: false,
    applyChecksum: false,
  })
  const endpoint = new Endpoint(`https://${API_HOST}`)

  function call(name, method, path, body) {
    // k6's goja runtime has no WHATWG URL/URLSearchParams; parse manually.
    const qIdx = path.indexOf('?')
    const pathname = qIdx === -1 ? path : path.substring(0, qIdx)
    const query = {}
    if (qIdx !== -1) {
      for (const pair of path.substring(qIdx + 1).split('&')) {
        if (!pair) continue
        const eq = pair.indexOf('=')
        const k = eq === -1 ? pair : pair.substring(0, eq)
        const v = eq === -1 ? '' : pair.substring(eq + 1)
        query[decodeURIComponent(k)] = decodeURIComponent(v)
      }
    }
    const signed = signer.sign({
      method,
      endpoint,
      path: pathname,
      query,
      headers: { Host: API_HOST, 'Content-Type': 'application/json' },
      body,
    })
    const res = http.request(method, signed.url, body || null, { headers: signed.headers })
    check(res, { [`${name} status 200`]: (r) => r.status === 200 })
    sleep(1)
    return res
  }

  // Simulate a typical bookstore user journey:
  // 1. Browse bestsellers
  // 2. Search for a book
  // 3. List/view books
  // 4. Add to cart
  // 5. View cart
  // 6. Checkout
  // 7. View orders

  // Real seed book ID from the bookstore Books table.
  const SAMPLE_BOOK_ID = '0ld0qvru-d93b-11e8-9f8b-f2801f1b9fd1'

  call('bestsellers',  'GET',  `/${API_STAGE}/bestsellers`)
  call('search',       'GET',  `/${API_STAGE}/search?q=fiction`)
  call('books list',   'GET',  `/${API_STAGE}/books`)
  call('book details', 'GET',  `/${API_STAGE}/books/${SAMPLE_BOOK_ID}`)
  call('add to cart',  'POST', `/${API_STAGE}/cart`, JSON.stringify({ bookId: SAMPLE_BOOK_ID, quantity: 1, price: 23.95 }))
  call('cart view',    'GET',  `/${API_STAGE}/cart`)
  call('checkout',     'POST', `/${API_STAGE}/orders`, JSON.stringify({ books: [{ bookId: SAMPLE_BOOK_ID, quantity: 1 }] }))
  call('orders list',  'GET',  `/${API_STAGE}/orders`)
}
