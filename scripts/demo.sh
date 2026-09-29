#!/usr/bin/env bash
# Walks the checkout-project story over the HTTP API and prints the session after each step.
# Requires the dev server: `npm run dev` on $BASE.
#
# Dev specifically, not a production build. The script drives the story with the debug knobs —
# moving the clock, changing a price, pulling a listing — and those routes answer 404 in a
# production build on purpose. See src/app/api/debug/[knob]/route.ts.
set -euo pipefail
BASE="${BASE:-http://localhost:3000}"
J='Content-Type: application/json'

if [ "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/debug/reset" || echo 000)" != "200" ]; then
  echo "The debug knobs aren't answering on $BASE." >&2
  echo "Start the dev server first: npm run dev   (a production build disables them by design)" >&2
  exit 1
fi

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
show() { python3 -c 'import sys,json; d=json.load(sys.stdin); s=d.get("session",{}); print("  status=%s version=%s total=%s priceVersion=%s code=%s priceChange=%s failReason=%s orderId=%s" % (s.get("status"), s.get("version"), s.get("quotedTotal"), s.get("priceVersion"), d.get("code"), d.get("priceChange"), s.get("failReason"), s.get("orderId")))'; }
field() { python3 -c "import sys,json; print(json.load(sys.stdin)$1)"; }

say "1. Fan starts checkout on WEB for listing L1"
R=$(curl -sS -X POST "$BASE/api/sessions" -H "$J" -d '{"listingId":"L1","quantity":1,"surface":"web"}')
echo "$R" | show
ID=$(echo "$R" | field '["session"]["id"]')
echo "  session id: $ID   web: $BASE/checkout/$ID   mobile: $BASE/checkout/$ID?surface=mobile"

say "2. Price rises while the fan is away"
curl -sS -X POST "$BASE/api/debug/price" -H "$J" -d '{"listingId":"L1","total":9900}' >/dev/null

say "3. Fan resumes on MOBILE → sees the price change"
R=$(curl -sS "$BASE/api/sessions/$ID?surface=mobile"); echo "$R" | show
V=$(echo "$R" | field '["session"]["version"]'); PV=$(echo "$R" | field '["session"]["priceVersion"]')

say "4. Mobile tries to pay at the old price → refused"
curl -sS -X POST "$BASE/api/sessions/$ID/complete" -H "$J" \
  -d "{\"version\":$V,\"priceVersion\":$PV,\"idempotencyKey\":\"m-1\",\"paymentToken\":\"tok\",\"surface\":\"mobile\"}" | show

say "5. Fan accepts the new price"
NPV=$(echo "$R" | field '["priceChange"]["newPriceVersion"]')
R=$(curl -sS -X POST "$BASE/api/sessions/$ID/accept-price" -H "$J" -d "{\"version\":$V,\"priceVersion\":$NPV,\"surface\":\"mobile\"}"); echo "$R" | show
V=$(echo "$R" | field '["session"]["version"]'); PV=$(echo "$R" | field '["session"]["priceVersion"]')

say "6. WEB tab (stale version) and MOBILE both press Pay at once → exactly one order"
curl -sS -X POST "$BASE/api/debug/payment" -H "$J" -d '{"next":"ok","delayMs":300}' >/dev/null
curl -sS -X POST "$BASE/api/sessions/$ID/complete" -H "$J" \
  -d "{\"version\":$V,\"priceVersion\":$PV,\"idempotencyKey\":\"web-1\",\"paymentToken\":\"tok\",\"surface\":\"web\"}" > /tmp/demo_a.json &
sleep 0.05
curl -sS -X POST "$BASE/api/sessions/$ID/complete" -H "$J" \
  -d "{\"version\":$V,\"priceVersion\":$PV,\"idempotencyKey\":\"mob-1\",\"paymentToken\":\"tok\",\"surface\":\"mobile\"}" > /tmp/demo_b.json
wait
echo "  web:";    show < /tmp/demo_a.json
echo "  mobile:"; show < /tmp/demo_b.json

say "7. Web retries with the SAME idempotency key → replayed, no second charge"
curl -sS -X POST "$BASE/api/sessions/$ID/complete" -H "$J" \
  -d "{\"version\":$V,\"priceVersion\":$PV,\"idempotencyKey\":\"web-1\",\"paymentToken\":\"tok\",\"surface\":\"web\"}" | show

say "8. A second session expires while away, then is re-held"
R=$(curl -sS -X POST "$BASE/api/sessions" -H "$J" -d '{"listingId":"L1","quantity":1,"surface":"web"}'); ID2=$(echo "$R" | field '["session"]["id"]')
curl -sS -X POST "$BASE/api/debug/advance" -H "$J" -d '{"ms":660000}' >/dev/null
curl -sS "$BASE/api/sessions/$ID2?surface=mobile" | show
curl -sS -X POST "$BASE/api/sessions/$ID2/rehold" | show

say "9. A third session: seller withdraws the listing mid-hold"
R=$(curl -sS -X POST "$BASE/api/sessions" -H "$J" -d '{"listingId":"L2","quantity":1,"surface":"mobile"}'); ID3=$(echo "$R" | field '["session"]["id"]')
curl -sS -X POST "$BASE/api/debug/withdraw" -H "$J" -d '{"listingId":"L2"}' >/dev/null
curl -sS "$BASE/api/sessions/$ID3?surface=web" | show

say "10. A fourth session: payment outcome unknown → stays PENDING, then reconciles"
curl -sS -X POST "$BASE/api/debug/restore" -H "$J" -d '{"listingId":"L2"}' >/dev/null
R=$(curl -sS -X POST "$BASE/api/sessions" -H "$J" -d '{"listingId":"L2","quantity":1,"surface":"web"}'); ID4=$(echo "$R" | field '["session"]["id"]')
V=$(echo "$R" | field '["session"]["version"]'); PV=$(echo "$R" | field '["session"]["priceVersion"]')
curl -sS -X POST "$BASE/api/debug/payment" -H "$J" -d '{"next":"unknown","delayMs":0}' >/dev/null
curl -sS -X POST "$BASE/api/sessions/$ID4/complete" -H "$J" \
  -d "{\"version\":$V,\"priceVersion\":$PV,\"idempotencyKey\":\"w-4\",\"paymentToken\":\"tok\",\"surface\":\"web\"}" | show
curl -sS -X POST "$BASE/api/debug/advance" -H "$J" -d '{"ms":180000}' >/dev/null
echo "  after pending timeout:"; curl -sS "$BASE/api/sessions/$ID4?surface=mobile" | show

say "Event log"
curl -sS "$BASE/api/debug/events" | python3 -c 'import sys,json; [print("  %-24s %s" % (e["name"], {k:v for k,v in e.items() if k not in ("name","ts")})) for e in json.load(sys.stdin)]'
