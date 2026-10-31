# Deploying OpenPrivy to AWS: a beginner's step-by-step

This guide takes you from an empty AWS account to a running **staging** copy of
the OpenPrivy backend. Do it in order. Each phase ends with a **Check** so you
know it worked before moving on. You can stop after any phase and come back.

Staging means a private test copy. Use test networks (Sepolia) only and keep
real money out until the launch gates in `PRODUCTION_STATUS.md` are closed.

**Time:** about one afternoon, mostly waiting for AWS.
**Cost:** roughly **US$300–400 a month** while staging runs (Kubernetes cluster
~$73, two servers, a database in two zones, Redis, one NAT gateway). These are
estimates; Phase 0 sets a budget alarm. Phase 14 shows how to delete
everything so the charges stop.

**What you end up with:** the backend API on AWS (Phases 0–10), optionally
public over HTTPS with the web app (Phases 11 and 11B), then the launch-gate
checks (Phase 12), the mobile app (Phase 13), and how to turn it all off
(Phase 14).

Every command below is typed into a terminal (Terminal on Mac, PowerShell or
WSL on Windows). Lines starting with `#` are comments; you don't type those.
Anything in `<ANGLE_BRACKETS>` is a value you replace.

---

## Phase 0: Make the account safe (15 min, AWS website)

1. Sign in to the AWS console as the account's **root user** (the email you
   signed up with).
2. Turn on MFA for root: top-right menu → **Security credentials** →
   **Assign MFA device**. Use an authenticator app.
3. Create an everyday admin login so you stop using root:
   search **IAM Identity Center** → Enable → **Users** → Add user → give it
   the `AdministratorAccess` permission set on this account. Note the **AWS
   access portal URL** it shows you. From now on, sign in with that user.
4. Set a budget alarm: search **Billing and Cost Management** → **Budgets** →
   Create budget → "Monthly cost budget" → amount `400` → your email.
5. Pick the region **US East (N. Virginia) / us-east-1** (top-right
   dropdown). The manifests in this repo assume `us-east-1`; using another
   region means editing them.

**Check:** you can sign in through the access portal URL, and the budget shows
under Budgets.

## Phase 1: Install the tools on your computer (30 min)

Install each of these, using the official installer for your OS:

| Tool | What it does | Where |
|---|---|---|
| AWS CLI v2 | talks to AWS from the terminal | search "install AWS CLI v2" on docs.aws.amazon.com |
| kubectl | controls Kubernetes | search "install kubectl" on kubernetes.io |
| eksctl | shortcuts for AWS Kubernetes | search "eksctl install" on eksctl.io |
| Helm | installs Kubernetes add-ons | search "install helm" on helm.sh |
| Docker Desktop | builds the server image | docker.com |
| git | gets the code | git-scm.com |

Then log the CLI in using the user from Phase 0:

```bash
aws configure sso
# SSO start URL: the access portal URL from Phase 0
# SSO region: us-east-1
# Choose the account and AdministratorAccess when asked
# CLI default region: us-east-1, output format: json
# Profile name: openprivy

export AWS_PROFILE=openprivy     # Windows PowerShell: $env:AWS_PROFILE="openprivy"
```

**Check:**

```bash
aws sts get-caller-identity      # prints your 12-digit Account ID
kubectl version --client
eksctl version
helm version
docker info                      # must not error; Docker Desktop must be running
```

Save your account ID; you'll use it a lot:

```bash
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export REGION=us-east-1
export CLUSTER=openprivy-staging
echo $ACCOUNT_ID
```

> If you open a new terminal window later, re-run the four `export` lines
> (`AWS_PROFILE`, `ACCOUNT_ID`, `REGION`, `CLUSTER`). If a command says your
> session expired, run `aws sso login`.

## Phase 2: Get the code (5 min)

```bash
git clone https://github.com/KHAYAAI/open-privy.git
cd open-privy
git checkout claude/privy-alternative-production-0qmmsn
```

Run every remaining command from inside this `open-privy` folder.

## Phase 3: Create the network and Kubernetes cluster (≈20 min wait)

This creates a private network (VPC) and an EKS cluster with 2 servers. The
template defaults to 3 larger servers for production; staging uses fewer and
smaller ones to save money.

```bash
aws cloudformation deploy \
  --template-file aws/cloudformation-vpc-eks.yaml \
  --stack-name $CLUSTER-network \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --parameter-overrides ClusterName=$CLUSTER NodeGroupMinSize=2 NodeInstanceType=t3.medium
```

It sits silently for 15–25 minutes. That's normal. You can watch progress in
the console: search **CloudFormation** → `openprivy-staging-network` →
**Events**.

**Check:** the command ends with `Successfully created/updated stack`. If it
fails, open the stack's **Events** tab and find the first red
`CREATE_FAILED` row; that line is the real reason. Send it to me.

## Phase 4: Create the database and Redis (≈20 min wait)

First read the network IDs the last stack created:

```bash
aws cloudformation describe-stacks --stack-name $CLUSTER-network \
  --query "Stacks[0].Outputs[*].[OutputKey,OutputValue]" --output table
```

Copy `VpcId`, `PrivateSubnet1` and `PrivateSubnet2` from the table:

```bash
export VPC_ID=<VpcId value>
export SUBNET1=<PrivateSubnet1 value>
export SUBNET2=<PrivateSubnet2 value>

aws cloudformation deploy \
  --template-file aws/cloudformation-databases.yaml \
  --stack-name $CLUSTER-data \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides ClusterName=$CLUSTER VpcId=$VPC_ID \
      PrivateSubnet1=$SUBNET1 PrivateSubnet2=$SUBNET2 DBInstanceClass=db.t3.small
```

This creates an encrypted PostgreSQL database in two zones with daily
backups, Redis, a backup bucket and alarms. AWS generates the database
password and stores it in Secrets Manager; you never type it.

**Check:**

```bash
aws cloudformation describe-stacks --stack-name $CLUSTER-data \
  --query "Stacks[0].Outputs[*].[OutputKey,OutputValue]" --output table
```

You should see `RDSEndpoint` and `RedisEndpoint`.

## Phase 5: Create the encryption master key (5 min). READ THIS ONE CAREFULLY

Every user's wallet key is encrypted with this master key. **If this key is
lost or deleted, every wallet becomes permanently unrecoverable.** Nobody,
including AWS, can get it back.

```bash
aws secretsmanager create-secret \
  --name $CLUSTER/encryption/master-key \
  --secret-string "$(openssl rand -base64 32)" \
  --query ARN --output text
```

It prints an ARN ending in a random 6-character suffix, like
`...:secret:openprivy-staging/encryption/master-key-AbC123`. Save the
**whole** ARN:

```bash
export MASTER_KEY_ARN=<the full ARN printed above>
```

Protect it:
- Never delete this secret. If you ever must, Secrets Manager keeps it
  recoverable for 7–30 days; don't use `--force-delete-without-recovery`.
- Production: replicate it to a second region (console → the secret →
  **Replicate secret**).
- Don't rotate it from the console or replace its value. Rotation has its own
  procedure that keeps old wallets readable (`docs/DR_RUNBOOK.md`, Scenario D).

**Check:** console → **Secrets Manager** shows three secrets: the master key,
`openprivy-staging/rds/password` and `openprivy-staging/redis/url`.

## Phase 6: Build the server image and upload it (20 min)

```bash
aws ecr create-repository --repository-name openprivy-backend \
  --image-scanning-configuration scanOnPush=true

aws ecr get-login-password | docker login --username AWS --password-stdin \
  $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com

export IMAGE=$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/openprivy-backend:staging-1

# --platform matters: AWS servers are Intel/AMD. Without it, an Apple-silicon
# Mac builds an ARM image that crashes on EKS with "exec format error".
docker buildx build --platform linux/amd64 \
  -f services/backend/Dockerfile -t $IMAGE --push .
```

The Dockerfile has never been built before this step, because the
development sandbox had no Docker. If the build fails, copy the last 30 lines
of output and send them to me.

**Check:** console → **ECR** → `openprivy-backend` shows an image tagged
`staging-1`.

## Phase 7: Connect kubectl to the cluster (2 min)

```bash
aws eks update-kubeconfig --name $CLUSTER --region $REGION
kubectl get nodes
```

**Check:** two nodes listed with STATUS `Ready`.

If you get "Unauthorized", your login isn't on the cluster's access list yet.
In the console: **EKS** → `openprivy-staging` → **Access** → **Create access
entry** → choose your IAM Identity Center role → add the policy
`AmazonEKSClusterAdminPolicy` (scope: Cluster). Then retry.

## Phase 8: Let the server read the master key (10 min)

The server reads the master key itself at startup, using its own AWS role,
so the key never sits in a config file. This is called IRSA.

```bash
# 1. Allow the cluster to issue AWS roles to pods (one time)
eksctl utils associate-iam-oidc-provider --cluster $CLUSTER --approve

# 2. A policy that can read ONLY the master key
cat > /tmp/openprivy-master-key-policy.json <<EOF
{ "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow",
    "Action": "secretsmanager:GetSecretValue",
    "Resource": "$MASTER_KEY_ARN" }] }
EOF
aws iam create-policy --policy-name openprivy-staging-master-key-read \
  --policy-document file:///tmp/openprivy-master-key-policy.json

# 3. A role for the backend's Kubernetes service account
eksctl create iamserviceaccount --cluster $CLUSTER \
  --namespace openprivy --name backend \
  --role-name openprivy-staging-backend-irsa --role-only \
  --attach-policy-arn arn:aws:iam::$ACCOUNT_ID:policy/openprivy-staging-master-key-read \
  --approve
```

**Check:** console → **IAM** → **Roles** → `openprivy-staging-backend-irsa`
exists and has the master-key policy attached.

## Phase 9: Put in your settings and secrets (15 min)

Make a staging copy of the manifests with your real values filled in. This
keeps the files in git as clean templates:

```bash
mkdir -p deploy-staging
sed -e "s#openprivy-backend:latest#$IMAGE#" \
    -e "s#arn:aws:secretsmanager:us-east-1:REPLACE_ACCOUNT_ID:secret:openprivy-prod/encryption/master-key#$MASTER_KEY_ARN#" \
    -e "s#arn:aws:iam::REPLACE_ACCOUNT_ID:role/openprivy-backend-irsa#arn:aws:iam::$ACCOUNT_ID:role/openprivy-staging-backend-irsa#" \
    -e "s#replicas: 3#replicas: 2#" -e "s#minReplicas: 3#minReplicas: 2#" \
    k8s/backend.yaml > deploy-staging/backend.yaml
sed "s#openprivy-backend:latest#$IMAGE#" k8s/migrate-job.yaml > deploy-staging/migrate-job.yaml
sed "s#openprivy-backend:latest#$IMAGE#" k8s/sanctions-sync-cronjob.yaml > deploy-staging/sanctions-sync-cronjob.yaml
grep -n "REPLACE" deploy-staging/*.yaml    # should print nothing
```

`deploy-staging/` is only on your computer. Don't commit it.

Now build the database and Redis addresses from what AWS generated:

```bash
DB_HOST=$(aws cloudformation describe-stacks --stack-name $CLUSTER-data \
  --query "Stacks[0].Outputs[?OutputKey=='RDSEndpoint'].OutputValue" --output text)
DB_PASS=$(aws secretsmanager get-secret-value --secret-id $CLUSTER/rds/password \
  --query SecretString --output text | python3 -c "import sys,json;print(json.load(sys.stdin)['password'])")
REDIS_URL=$(aws secretsmanager get-secret-value --secret-id $CLUSTER/redis/url \
  --query SecretString --output text)
```

Get these from the providers' dashboards (you can leave a value as `""` for
now; that feature just stays off):

- **Alchemy** (alchemy.com): a free app on Ethereum Sepolia → its HTTPS URL
  and API key.
- **WorkOS** (dashboard.workos.com): OPEN PRIVY project → **Staging** →
  API Keys → the `sk_test_...` key. Client ID is
  `client_01M0E4NP2BATG2MTE1707JV23Y`.
- **Pimlico** (pimlico.io): API key, only needed for gasless transactions.

Create the namespace and the secret. This is the only place real secrets go:

```bash
kubectl apply -f k8s/namespace.yaml

kubectl create secret generic backend-secrets -n openprivy \
  --from-literal=DATABASE_URL="postgresql://openprivy_admin:$DB_PASS@$DB_HOST:5432/openprivy" \
  --from-literal=REDIS_URL="$REDIS_URL" \
  --from-literal=JWT_SECRET="$(openssl rand -base64 48)" \
  --from-literal=ETHEREUM_RPC_SEPOLIA="<alchemy sepolia https url>" \
  --from-literal=ALCHEMY_API_KEY="<alchemy key>" \
  --from-literal=WORKOS_API_KEY="<sk_test_...>" \
  --from-literal=WORKOS_CLIENT_ID="client_01M0E4NP2BATG2MTE1707JV23Y" \
  --from-literal=WORKOS_REDIRECT_URI="http://localhost:3001/auth/workos/callback" \
  --from-literal=PIMLICO_API_KEY=""
```

(The redirect URI uses `localhost` for now because Phase 11 makes the public
address. You'll update it then.)

**Check:** `kubectl get secret backend-secrets -n openprivy` lists it with
DATA around 9.

## Phase 10: Create the tables and start the server (10 min)

```bash
# Database tables (runs once, then stops)
kubectl apply -f deploy-staging/migrate-job.yaml
kubectl wait --for=condition=complete job/db-migrate -n openprivy --timeout=300s
kubectl logs job/db-migrate -n openprivy | tail -20

# The server itself, plus the daily sanctions-list sync
kubectl apply -f deploy-staging/backend.yaml
kubectl apply -f deploy-staging/sanctions-sync-cronjob.yaml
kubectl rollout status deployment/backend -n openprivy --timeout=5m
```

**Check:** talk to it privately through a tunnel (nothing public yet):

```bash
kubectl port-forward -n openprivy svc/backend 3001:3001
```

Leave that running, open a second terminal, and:

```bash
curl http://localhost:3001/health        # expect {"status":"ok",...}
```

Then load the sanctions list once by hand instead of waiting for the
6-hourly schedule. Until it
loads, the server correctly **blocks all sends**:

```bash
kubectl create job -n openprivy --from=cronjob/sanctions-sync sanctions-first-run
kubectl logs -n openprivy job/sanctions-first-run -f
```

**If something fails here**, these show the reason:

```bash
kubectl get pods -n openprivy
kubectl describe pod <pod-name> -n openprivy     # look at "Events" at the bottom
kubectl logs <pod-name> -n openprivy
```

Common ones:
- `ImagePullBackOff`: the image name in `deploy-staging/` doesn't match
  Phase 6, or you skipped `--push`.
- `exec format error`: rebuild with `--platform linux/amd64`.
- `No master key configured` / `AccessDenied` on secretsmanager: Phase 8's
  role or the ARN in Phase 9 is wrong. Use the full ARN with its suffix.
- `password authentication failed` or `no pg_hba.conf entry`: re-run the
  Phase 9 commands that build `DATABASE_URL`, then recreate the secret
  (`kubectl delete secret backend-secrets -n openprivy`, create again,
  `kubectl rollout restart deployment/backend -n openprivy`).

**At this point you have a working staging backend.** Stop here if you like;
Phase 11 only makes it reachable from the internet.

## Phase 11 (optional): Public HTTPS address (≈1 hour)

You need a domain you control. The manifests use `api.openprivy.io`; replace
it with your own (for staging, e.g. `api-staging.<yourdomain>`).

1. **Certificate**: console → **Certificate Manager** → Request → public
   certificate → your API hostname → DNS validation. Add the CNAME record it
   shows at your domain registrar (or click "Create records in Route 53" if
   your domain is there). Wait until status is **Issued**. Copy its ARN.
2. **Install the AWS Load Balancer Controller** (turns the Ingress into a real
   load balancer):

   ```bash
   curl -o /tmp/alb-iam-policy.json \
     https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.7.2/docs/install/iam_policy.json
   aws iam create-policy --policy-name openprivy-staging-alb-controller \
     --policy-document file:///tmp/alb-iam-policy.json
   eksctl create iamserviceaccount --cluster $CLUSTER \
     --namespace kube-system --name aws-load-balancer-controller \
     --attach-policy-arn arn:aws:iam::$ACCOUNT_ID:policy/openprivy-staging-alb-controller \
     --approve
   helm repo add eks https://aws.github.io/eks-charts && helm repo update
   helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
     -n kube-system --set clusterName=$CLUSTER \
     --set serviceAccount.create=false --set serviceAccount.name=aws-load-balancer-controller \
     --set region=$REGION --set vpcId=$VPC_ID
   kubectl get deployment -n kube-system aws-load-balancer-controller   # READY 2/2
   ```

3. **Ingress**:

   ```bash
   sed -e "s#arn:aws:acm:us-east-1:REPLACE_ACCOUNT_ID:certificate/REPLACE_CERT_ID#<your certificate ARN>#" \
       -e "s#api.openprivy.io#<your api hostname>#g" \
       k8s/ingress.yaml > deploy-staging/ingress.yaml
   kubectl apply -f deploy-staging/ingress.yaml
   kubectl get ingress -n openprivy -w      # wait for an ADDRESS ending in elb.amazonaws.com
   ```

4. **DNS**: at your registrar, add a CNAME from your API hostname to that
   `...elb.amazonaws.com` address.
5. **WorkOS**: in the WorkOS dashboard (Staging → Redirects) add
   `https://<your api hostname>/auth/workos/callback`, then update the secret's
   `WORKOS_REDIRECT_URI` to the same value and restart:
   `kubectl rollout restart deployment/backend -n openprivy`.

**Check:** `curl https://<your api hostname>/health` returns ok from any
computer. The real sign-in test happens in Phase 11B, through the web app.

## Phase 11B (optional): The web app (≈30 min)

The web app runs on **AWS Amplify Hosting**, which builds it straight from
GitHub. One rule matters: the web app and the API must be on **the same
parent domain** (for example `app-staging.example.com` and
`api-staging.example.com`). The login cookie is only sent between sites that
share a parent domain, so Amplify's default `*.amplifyapp.com` address will
show the sign-in page but never stay signed in.

1. Console → search **Amplify** → **Create new app** → **GitHub** → authorize
   → repository `open-privy`, branch `claude/privy-alternative-production-0qmmsn`.
2. Tick **My app is a monorepo** and enter `apps/web` as the app root.
   Amplify detects Next.js and picks up `amplify.yml` from the repository.
3. **Environment variables**: add `NEXT_PUBLIC_API_URL` =
   `https://<your api hostname>`. Then **Save and deploy** (about 5 minutes).
4. **Custom domain**: the app → **Hosting** → **Custom domains** → add your
   domain and the subdomain `app-staging`. Follow the DNS records it shows
   (automatic if your domain is in Route 53). Wait for **Available**.
5. Tell the backend about the web app (replace both addresses):

   ```bash
   kubectl set env deployment/backend -n openprivy \
     CORS_ORIGINS=https://app-staging.<yourdomain> \
     WORKOS_POST_LOGIN_REDIRECT=https://app-staging.<yourdomain>/dashboard
   ```

   This restarts the server pods automatically.

**Check:** open `https://app-staging.<yourdomain>`, click **Get started**,
then **Continue**. Sign in through WorkOS (any Google account or email).
You should land on **Your wallet**. Click **Create wallet**: an address
appears. That single login is the last untested piece of sign-in.

If you land back on the sign-in page after logging in, the two addresses are
not on the same parent domain, or `CORS_ORIGINS` does not exactly match the
web address (including `https://` and no trailing slash).

## Phase 12: Launch-gate checks on staging

These close the remaining engineering gates in `PRODUCTION_STATUS.md`. Do
them in any order, and send me each result.

### 12a. Database failover (10 min)

Simulates the database server dying. AWS switches to the standby copy in
the other zone.

```bash
DB_ID=$(aws rds describe-db-instances \
  --query "DBInstances[?contains(DBInstanceIdentifier,'$CLUSTER') || contains(Endpoint.Address,'$CLUSTER')].DBInstanceIdentifier" \
  --output text)
date; aws rds reboot-db-instance --db-instance-identifier $DB_ID --force-failover
# in a second terminal, until it settles:
while true; do date +%T; curl -s -o /dev/null -w '%{http_code}\n' https://<your api hostname>/health; sleep 5; done
```

**Check:** `/health` returns 200 again within about 2 minutes, and your
wallet still shows on the web app. Send me the start time and the time it
came back.

### 12b. Point-in-time restore (30 min, mostly waiting)

Proves you can rewind the database to any minute in the last 30 days. It
restores into a **new, separate** database and leaves the live one alone.

```bash
SUBNET_GROUP=$(aws rds describe-db-instances --db-instance-identifier $DB_ID \
  --query "DBInstances[0].DBSubnetGroup.DBSubnetGroupName" --output text)
SG=$(aws rds describe-db-instances --db-instance-identifier $DB_ID \
  --query "DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId" --output text)
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier $DB_ID \
  --target-db-instance-identifier $CLUSTER-pitr-test \
  --use-latest-restorable-time \
  --db-subnet-group-name $SUBNET_GROUP --vpc-security-group-ids $SG \
  --db-instance-class db.t3.small --no-multi-az
aws rds wait db-instance-available --db-instance-identifier $CLUSTER-pitr-test
aws rds describe-db-instances --db-instance-identifier $CLUSTER-pitr-test \
  --query "DBInstances[0].[DBInstanceStatus,Endpoint.Address]" --output text
```

**Check:** status `available`. Send me that output; I'll walk you through
pointing one test pod at it to confirm a wallet decrypts. Then delete it so
it stops costing money:

```bash
aws rds delete-db-instance --db-instance-identifier $CLUSTER-pitr-test --skip-final-snapshot
```

### 12c. Load test (20 min)

Install **k6** (search "install k6" on grafana.com), then:

```bash
k6 run -e BASE_URL=https://<your api hostname> services/backend/test/load/api-load.k6.js
```

The rate limiter will start returning 429s, because every request comes
from your one computer. That is expected. Send me the summary k6 prints at
the end; I'll size the database, Redis and autoscaling from it.

### 12d. Gasless transaction on Sepolia (together)

This needs a Pimlico API key (Phase 9) and a little Sepolia test ETH from a
public faucet in a fresh test wallet. Tell me when you have both and we'll
deploy the contracts and send the first sponsored transaction together. You
won't need to share the wallet's private key: you'll paste it into one
command on your own computer.

## Phase 13 (optional): Try the mobile app

The mobile app signs in through an `openprivy://` link, which the Expo Go
app cannot open, so you install a real build of it instead:

1. Create a free account at expo.dev. On your computer:
   ```bash
   cd apps/mobile
   npm install --legacy-peer-deps
   npx eas-cli login
   ```
2. Open `apps/mobile/eas.json` and replace `https://api-staging.example.com`
   with your API address from Phase 11.
3. Build it in Expo's cloud (about 15 minutes):
   ```bash
   npx eas-cli build --profile preview --platform android
   ```
   It prints a link: open it on an Android phone to install. For iPhone use
   `--platform ios`; Apple requires a paid developer account ($99/year) to
   install test builds.
4. Nothing changes in WorkOS: the phone signs in through the same backend
   callback, which hands the app a one-time code.

**Check:** open the app, tap **Continue**, sign in, then **Create wallet**
(or see the one you made on the web, since it's the same account).

## Phase 14: Turning it off (so you stop paying)

Delete in this order. The cluster and database are most of the cost.

The database has **deletion protection** switched on, so a delete fails until
you turn it off on purpose. That's a safety feature.

```bash
kubectl delete -f deploy-staging/ingress.yaml        # if you did Phase 11 (removes the load balancer)
# If you did Phase 11B: Amplify console -> your app -> App settings -> General -> Delete app

# Turn off deletion protection on the database
DB_ID=$(aws rds describe-db-instances \
  --query "DBInstances[?contains(DBInstanceIdentifier,'$CLUSTER') || contains(Endpoint.Address,'$CLUSTER')].DBInstanceIdentifier" \
  --output text)
echo $DB_ID      # if empty, find the name in the RDS console under Databases
aws rds modify-db-instance --db-instance-identifier $DB_ID \
  --no-deletion-protection --apply-immediately

aws cloudformation delete-stack --stack-name $CLUSTER-data
aws cloudformation wait stack-delete-complete --stack-name $CLUSTER-data
aws cloudformation delete-stack --stack-name $CLUSTER-network
```

Deliberately left behind, so a mistaken delete isn't fatal:
- a **final database snapshot** (small monthly cost; delete it in RDS →
  Snapshots once you're sure), and
- the **backup S3 bucket** (empty and delete it in the S3 console if unused).

**Keep the master-key secret** if any wallet data you care about exists
anywhere.

---

## After staging is up: what to send me

What to send me: the outputs of `kubectl get pods -n openprivy` and the
`/health` check. **Never paste the master key, database password, JWT secret
or WorkOS `sk_` key into a chat**, including this one. Nothing in these
steps needs you to.
