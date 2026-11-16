#!/usr/bin/env bash
# Tear down everything created for the deploy-ledger demo in the AWS account given by ACCOUNT_ID.
#
# Dry-run by default: it only prints what it WOULD delete. Pass --execute to delete.
# Delete in layers so you choose how far to go:
#
#   (default)        app stacks only:   DeployLedgerApi, DeployLedgerData (+ their log groups)
#   --toolkit        also the CDK bootstrap: CDKToolkit stack, its S3 bucket and ECR repo
#   --iam            also DeployLedgerCfnExecutionPolicy (needs --toolkit first or already gone)
#   --harness-role   also HarnessDeployLedgerRole. WARNING: the Harness pipeline can no longer
#                    deploy or destroy after this, so it is always the last step.
#
# Never touched: the shared Harness OIDC provider, or any other role, policy, bucket, repo
# or toolkit stack in the account (including other regions).
#
# Usage: ACCOUNT_ID=<account-id> AWS_PROFILE=<profile> scripts/cleanup.sh [--execute] [--toolkit] [--iam] [--harness-role]
set -euo pipefail

ACCOUNT="${ACCOUNT_ID:?Set ACCOUNT_ID to the 12-digit AWS account id you intend to clean}"
REGION=us-east-1
QUALIFIER=hnb659fds
EXEC_POLICY=DeployLedgerCfnExecutionPolicy
HARNESS_ROLE=HarnessDeployLedgerRole
HARNESS_INLINE_POLICY=DeployLedgerHarness
BUCKET="cdk-${QUALIFIER}-assets-${ACCOUNT}-${REGION}"
REPO="cdk-${QUALIFIER}-container-assets-${ACCOUNT}-${REGION}"

EXECUTE=0 TOOLKIT=0 IAM=0 HARNESS_ROLE_DEL=0
for arg in "$@"; do
  case "$arg" in
    --execute) EXECUTE=1 ;;
    --toolkit) TOOLKIT=1 ;;
    --iam) IAM=1 ;;
    --harness-role) HARNESS_ROLE_DEL=1 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

export AWS_DEFAULT_REGION="$REGION"
actual=$(aws sts get-caller-identity --query Account --output text)
if [[ "$actual" != "$ACCOUNT" ]]; then
  echo "Refusing to run: current credentials are for account $actual, expected $ACCOUNT." >&2
  exit 1
fi

run() { # run a mutating command, or just print it in dry-run mode
  if (( EXECUTE )); then echo "+ $*"; "$@"; else echo "[dry-run] $*"; fi
}
stack_exists() { aws cloudformation describe-stacks --stack-name "$1" >/dev/null 2>&1; }

if (( EXECUTE )); then
  echo "About to DELETE resources in account $ACCOUNT ($REGION):"
  echo "  app stacks: yes | toolkit: $TOOLKIT | policy: $IAM | harness role: $HARNESS_ROLE_DEL"
  read -r -p "Type the account id to continue: " confirm
  [[ "$confirm" == "$ACCOUNT" ]] || { echo "Aborted."; exit 1; }
else
  echo "DRY RUN (nothing will be deleted). Re-run with --execute to apply."
fi

# 1. App stacks. Api imports from Data, so Api goes first. Table and log groups are DESTROY.
for stack in DeployLedgerApi DeployLedgerData; do
  if stack_exists "$stack"; then
    run aws cloudformation delete-stack --stack-name "$stack"
    (( EXECUTE )) && aws cloudformation wait stack-delete-complete --stack-name "$stack"
  else
    echo "skip: stack $stack not found"
  fi
done

# 2. CDK bootstrap (shared by every CDK app in this account/region, so opt-in).
if (( TOOLKIT )); then
  if stack_exists CDKToolkit; then
    # The assets bucket is versioned and must be empty or stack deletion fails/retains it.
    if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
      echo "Emptying s3://$BUCKET (all versions)"
      if (( EXECUTE )); then
        while read -r key ver; do
          [[ -n "$key" && "$key" != "None" ]] && aws s3api delete-object --bucket "$BUCKET" --key "$key" --version-id "$ver" >/dev/null
        done < <(aws s3api list-object-versions --bucket "$BUCKET" \
          --query '[Versions,DeleteMarkers][][].[Key,VersionId]' --output text)
      else
        echo "[dry-run] delete all object versions in s3://$BUCKET"
      fi
    fi
    if aws ecr describe-repositories --repository-names "$REPO" >/dev/null 2>&1; then
      run aws ecr delete-repository --repository-name "$REPO" --force
    fi
    run aws cloudformation delete-stack --stack-name CDKToolkit
    (( EXECUTE )) && aws cloudformation wait stack-delete-complete --stack-name CDKToolkit
    # The template retains the bucket by default; remove it if it survived.
    if (( EXECUTE )) && aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
      run aws s3api delete-bucket --bucket "$BUCKET"
    fi
  else
    echo "skip: CDKToolkit not found"
  fi
fi

# 3. Scoped CloudFormation execution policy. It must be detached from the exec role first,
#    which happens when CDKToolkit is deleted.
if (( IAM )); then
  arn="arn:aws:iam::${ACCOUNT}:policy/${EXEC_POLICY}"
  if aws iam get-policy --policy-arn "$arn" >/dev/null 2>&1; then
    attached=$(aws iam list-entities-for-policy --policy-arn "$arn" --query 'length(PolicyRoles)' --output text)
    if [[ "$attached" != "0" ]] && (( EXECUTE )); then
      echo "Policy still attached to $attached role(s); run with --toolkit first." >&2; exit 1
    fi
    for v in $(aws iam list-policy-versions --policy-arn "$arn" --query 'Versions[?!IsDefaultVersion].VersionId' --output text); do
      run aws iam delete-policy-version --policy-arn "$arn" --version-id "$v"
    done
    run aws iam delete-policy --policy-arn "$arn"
  else
    echo "skip: policy $EXEC_POLICY not found"
  fi
fi

# 4. Harness OIDC deploy role (last: Harness cannot run this account's pipeline without it).
if (( HARNESS_ROLE_DEL )); then
  if aws iam get-role --role-name "$HARNESS_ROLE" >/dev/null 2>&1; then
    run aws iam delete-role-policy --role-name "$HARNESS_ROLE" --policy-name "$HARNESS_INLINE_POLICY"
    run aws iam delete-role --role-name "$HARNESS_ROLE"
  else
    echo "skip: role $HARNESS_ROLE not found"
  fi
fi

echo "Done."
