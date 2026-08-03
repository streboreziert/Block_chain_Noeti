#!/usr/bin/env bash
# End-to-end smoke test (requires running network + Ollama)
set -euo pipefail
API="${NOETIS_API_URL:-http://localhost:3001}"

echo "Creating wallet..."
WALLET=$(curl -s -X POST "$API/api/wallets")
ADDRESS=$(echo "$WALLET" | python3 -c "import sys,json; print(json.load(sys.stdin)['address'])")
PRIVATE=$(echo "$WALLET" | python3 -c "import sys,json; print(json.load(sys.stdin)['private_key'])")
PUB=$(echo "$WALLET" | python3 -c "import sys,json; print(json.load(sys.stdin)['public_key'])")

echo "Faucet for $ADDRESS..."
curl -s -X POST "$API/api/faucet" -H 'Content-Type: application/json' -d "{\"address\":\"$ADDRESS\"}"

NONCE=$(python3 -c "import uuid; print(uuid.uuid4())")
TS=$(python3 -c "import time; print(int(time.time()*1000))")
SIG=$(node -e "
const ed=require('@noble/ed25519');
const {utf8ToBytes,hexToBytes}=require('@noble/hashes/utils');
(async()=>{
  const msg=JSON.stringify({wallet_address:'$ADDRESS',timestamp:$TS,nonce:'$NONCE'},Object.keys({wallet_address:'$ADDRESS',timestamp:$TS,nonce:'$NONCE'}).sort());
  const sk=hexToBytes('$PRIVATE');
  const sig=await ed.signAsync(utf8ToBytes(msg),sk);
  console.log(Buffer.from(sig).toString('base64'));
})();
")

echo "Submitting task..."
TASK=$(curl -s -X POST "$API/api/tasks" -H 'Content-Type: application/json' -d "{
  \"wallet_address\":\"$ADDRESS\",
  \"prompt\":\"Say hello in one word.\",
  \"model\":\"llama3.2:3b\",
  \"max_output_tokens\":32,
  \"verification_level\":\"low\",
  \"processing_mode\":\"single\",
  \"signature\":\"$SIG\",
  \"timestamp\":$TS,
  \"nonce\":\"$NONCE\"
}")
echo "$TASK"
TASK_ID=$(echo "$TASK" | python3 -c "import sys,json; print(json.load(sys.stdin).get('task_id',''))")

for i in $(seq 1 60); do
  sleep 2
  STATUS=$(curl -s "$API/api/tasks/$TASK_ID" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))")
  echo "Status: $STATUS"
  if [ "$STATUS" = "finalized" ]; then
    curl -s "$API/api/tasks/$TASK_ID/result" | python3 -m json.tool
    exit 0
  fi
done
echo "Task did not finalize in time"
exit 1
