# TimeBlocker AI backend (`TimeBlockerAiStack`)

A small private API for the app's AI features (requirements R32 to R35, design D28 and D29).

```
Phone --HTTPS + Google ID token--> API Gateway HTTP API (JWT authorizer)
      --> Lambda (sub allow-list, validation, Converse tool use) --> Bedrock ca.amazon.nova-lite-v1:0
```

- Region: `ca-central-1`. The model is called through the Canada inference profile `ca.amazon.nova-lite-v1:0`, which routes between `ca-central-1` and `ca-west-1` only.
- Routes: `POST /ai/parse-tasks` and `POST /ai/application-help`. Nothing else is exposed.
- The legacy `TimeblockerStack` in the same app is never deployed.
- The API contract types are in `ai/contract.ts` (mirror them in the app).

## Prerequisites

- Node.js 22 and npm.
- An AWS profile that assumes `TimeBlockerDeployRole` with MFA. Add this to `~/.aws/config` (replace the MFA serial with yours):

```ini
[profile timeblocker-deploy]
role_arn = arn:aws:iam::<ACCOUNT_ID>:role/TimeBlockerDeployRole
source_profile = default
mfa_serial = arn:aws:iam::<ACCOUNT_ID>:mfa/<your-mfa-device-name>
region = ca-central-1
```

- The Android OAuth client id used by the app (`<id>.apps.googleusercontent.com`). It becomes the JWT audience.
- An email address for budget and alarm notifications.
- Bedrock access to Amazon Nova Lite in `ca-central-1` (check in the Bedrock console that the model can be used from your account before the first call).
- Lambda concurrency: this stack does not reserve concurrency. New accounts often have a total quota of 10 concurrent executions (yours does), and AWS requires 10 to stay unreserved, so any reservation would fail the deploy. The 2 requests per second stage limit and the account quota itself cap the load.

## Commands, in order

Run all of these from the repo root unless noted.

1. Install dependencies:

```sh
cd packages/infra && npm ci
```

2. Bootstrap CDK. This is needed once per account and region. It creates the `CDKToolkit` stack, an asset bucket, and deployment roles. The `cfn-exec` role it creates has `AdministratorAccess`, but only CloudFormation can assume it; your own profile does not gain those permissions.

```sh
npx cdk bootstrap aws://<ACCOUNT_ID>/ca-central-1 --profile timeblocker-deploy
```

3. Review what will be created (nothing is changed by `diff`):

```sh
npx cdk diff TimeBlockerAiStack \
  -c googleClientId=<id>.apps.googleusercontent.com \
  -c allowedSubs=<sub> \
  -c budgetEmail=<email> \
  --profile timeblocker-deploy
```

Check that the IAM section lists only `bedrock:InvokeModel` on the three Bedrock ARNs (the `ca.amazon.nova-lite-v1:0` inference profile in your account, and the `amazon.nova-lite-v1:0` foundation model in `ca-central-1` and `ca-west-1`) plus log writes to the function's own log group.

4. Deploy:

```sh
npx cdk deploy TimeBlockerAiStack \
  -c googleClientId=<id>.apps.googleusercontent.com \
  -c allowedSubs=<sub> \
  -c budgetEmail=<email> \
  --profile timeblocker-deploy \
  --require-approval broadening
```

Confirm the SNS subscription email that AWS sends to `budgetEmail`; alarm emails do not arrive until you do. The Budget emails do not need confirmation.

## Reading `ApiUrl`

The deploy prints the stack output at the end:

```
TimeBlockerAiStack.ApiUrl = https://<api-id>.execute-api.ca-central-1.amazonaws.com
```

To read it again later:

```sh
aws cloudformation describe-stacks --stack-name TimeBlockerAiStack \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text \
  --profile timeblocker-deploy
```

Paste it into the app's `src/config.ts` as `AI_API_BASE_URL` (no trailing slash).

## Finding your Google `sub` (the allow-list)

The allow-list is the `allowedSubs` context value: a comma separated list of Google `sub` claims. An empty value denies everybody.

1. Deploy the first time with `-c allowedSubs=` (empty). The API rejects every request with 403.
2. In the app, sign in and open Settings > AI assistant. The "Your Google ID" row shows your `sub`.
3. Redeploy with `-c allowedSubs=<that sub>`. Context values are not remembered between runs, so pass `googleClientId`, `allowedSubs` and `budgetEmail` on every deploy.

## Testing with curl

A valid Google ID token (not an access token) for the same OAuth client is required, and its `sub` must be on the allow-list. Without a valid token the API Gateway authorizer returns 401; with a valid token and a different `sub` the Lambda returns 403 `{"error":"forbidden"}`.

```sh
curl -sS -X POST "$API_URL/ai/parse-tasks" \
  -H "Authorization: Bearer $GOOGLE_ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"titles":["apply to the Shopify internship","email prof about the extension","leg day"]}'
```

Expected: `{"items":[{"index":0,"category":"work","kind":"application"}, ...]}`. Google ID tokens expire after about an hour. Do not paste real tokens into shell history shared with others.

## Cost notes

- Nova Lite on-demand pricing is roughly 0.06 USD per million input tokens and 0.24 USD per million output tokens (check the Bedrock pricing page for current rates). A typical call costs a small fraction of a cent.
- Output is capped by `maxTokens` (700 for parse-tasks, 900 for application-help, 400 for the second draft step) and the request body is limited to 16 KB.
- Hard caps: 2 requests per second (burst 5) at the stage, Lambda timeout of 25 seconds.
- Lambda, API Gateway HTTP API, CloudWatch Logs (14 day retention) and SNS at this volume are expected to cost cents per month or fall in the free tier.
- The AWS Budget is 5 USD per month and emails at 50% and 100% of actual spend. A Budget only notifies; it does not stop spend. The alarms (Lambda errors >= 3 in 5 minutes, more than 500 invocations in a day) email the same address.
- Bedrock model invocation logging stays off. The function logs one JSON line per request with the route, status, model latency, and token counts only.

## Tear down

```sh
npx cdk destroy TimeBlockerAiStack \
  -c googleClientId=<id>.apps.googleusercontent.com \
  --profile timeblocker-deploy
```

This removes the API, function, log group, alarms, topic, and budget. The `CDKToolkit` bootstrap stack and its asset bucket stay; delete them separately only if you no longer use CDK in this account and region.

## Security

What is protected:

- Every request needs a Google ID token accepted by the API Gateway JWT authorizer (issuer `https://accounts.google.com`, audience equal to the OAuth client id). The Lambda then requires the token's `sub` to be on the allow-list before it reads the request body. Anyone else gets 401 or 403 and Bedrock is not called.
- The phone never holds AWS credentials. Only the Lambda role can call Bedrock.
- The Lambda role can do only two things: `bedrock:InvokeModel` on the inference profile `ca.amazon.nova-lite-v1:0` in this account and on the `amazon.nova-lite-v1:0` foundation model in `ca-central-1` and `ca-west-1`, and write logs to its own log group. It cannot read S3, DynamoDB, Secrets Manager, or any other service, and it has no managed policies attached.
- No buckets, tables, secrets, or function URLs are created.
- Request text, model output, and tokens are not logged. Error responses never echo input.
- User text is passed to the model as data, with a system prompt rule to ignore instructions inside it. Talking points are only kept when their quote is found verbatim in the user's own background, and the output is validated against a fixed schema.

What the deploy role can and cannot do:

- `TimeBlockerDeployRole` can be assumed only by the owner's IAM user with MFA (`iam/trust-policy.json`).
- Its IAM permissions (`iam/deploy-iam-policy.json`) allow creating and changing roles named `TimeBlocker*` and `cdk-*`, deny attaching `AdministratorAccess` to `TimeBlocker*` roles, and deny creating users, access keys, and login profiles or changing MFA.
- CloudFormation performs the actual resource creation through the bootstrap `cfn-exec` role. That role has `AdministratorAccess`; it is not assumable by your profile.

Known limits:

- A single allowed Google account is a trust boundary, not a rate limiter per user; throttling is global for the API.
- Cross-region inference means prompts may be processed in `ca-west-1` as well as `ca-central-1`; both are in Canada.
