## Publish the agent layer to your AWS account

The workflow in `.github/workflows/release.yml` authenticates to Elastic's
account `267093732750`, publishes layers in multiple regions with public access,
and publishes npm/GitHub releases for release tags. For this private build, use
the same local distribution builder and the single-region AWS CLI steps below.
No Git tag or workflow change is needed.

### 1. Build the layer locally

Run from the repository root with Node.js 22 or 24, npm >=8, and `zip` installed:

```sh
bash dev-utils/make-distribution.sh
```

This produces `build/dist/elastic-apm-node-lambda-layer.zip` using production
dependencies from the repository lockfile. Its layout is:

```text
nodejs/
  node_modules/
    elastic-apm-node/
      package.json  # version 4.18.1
      lib/
      node_modules/
      ...
```

Lambda extracts this under `/opt/nodejs`, where Node.js can resolve the agent.
The layer contains the agent and its dependencies. Keep Elastic's **extension**
layer attached separately. The Nosto CA certificate stays in your function ZIP
at `/var/task/ca-cert-Nosto.crt`; it is not part of the agent layer.

### 2. Publish a private layer version in us-west-1

These commands write to AWS; run them yourself using a profile with
`lambda:PublishLayerVersion` permission in your account:

```sh
export AWS_PROFILE=your-write-enabled-profile
export AWS_REGION=us-west-1

aws sts get-caller-identity --query '{Account:Account,Arn:Arn}'

AGENT_LAYER_ARN=$(aws lambda publish-layer-version --region "$AWS_REGION" \
  --layer-name nosto-elastic-apm-node-4-18-1 \
  --description 'Elastic APM 4.18.1 with Node.js 24 Lambda fix' \
  --license-info BSD-2-Clause \
  --compatible-runtimes nodejs20.x nodejs22.x nodejs24.x \
  --compatible-architectures x86_64 arm64 \
  --zip-file fileb://build/dist/elastic-apm-node-lambda-layer.zip \
  --query LayerVersionArn --output text)
export AGENT_LAYER_ARN
printf '%s\n' "$AGENT_LAYER_ARN"
```

Verify `get-caller-identity` shows account **`953585160895`** before publishing.
The returned ARN will have this shape:

```text
arn:aws:lambda:us-west-1:953585160895:layer:nosto-elastic-apm-node-4-18-1:1
```

Use the returned version number rather than assuming `:1`: each publish creates
a new, immutable AWS layer version. The agent package version
`4.18.1` and AWS's numeric layer version are separate. The layer remains
private to your account; no public-access policy is required. Repeat publication
in another region if you need to attach it to functions there.

### 3. Attach the agent layer to your functions

### 4. Ensure the layer's agent is the one being loaded