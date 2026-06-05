#!/bin/bash
# scripts/monitor-dlq.sh
# Monitor Kafka Dead Letter Queues for failed events

set -e

KAFKA_BROKERS="${KAFKA_BROKERS:-localhost:9092}"
ALERT_WEBHOOK="${ALERT_WEBHOOK:-}"
DLQ_TOPICS=(
  "catch-events-dlq"
  "user-events-dlq"
  "social-events-dlq"
  "reward-events-dlq"
  "payment-events-dlq"
  "location-events-dlq"
  "gym-events-dlq"
)

# Colors for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

echo "=== Kafka DLQ Monitor ==="
echo "Brokers: $KAFKA_BROKERS"
echo "Time: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo ""

# Check if kafka-console-consumer is available
if ! command -v kafka-console-consumer.sh &> /dev/null; then
  echo -e "${YELLOW}Warning: kafka-console-consumer.sh not found in PATH${NC}"
  echo "Using kubectl exec to access Kafka..."
  
  # Use kubectl if Kafka is running in K8s
  KAFKA_POD=$(kubectl get pods -n minego -l app.kubernetes.io/name=kafka -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  
  if [ -z "$KAFKA_POD" ]; then
    echo -e "${RED}Error: No Kafka pod found in minego namespace${NC}"
    exit 1
  fi
  
  CONSUMER_CMD="kubectl exec -n minego $KAFKA_POD -- kafka-console-consumer.sh"
else
  CONSUMER_CMD="kafka-console-consumer.sh"
fi

# Check DLQ topics
TOTAL_MESSAGES=0
ALERT_NEEDED=false

for topic in "${DLQ_TOPICS[@]}"; do
  echo "Checking topic: $topic"
  
  # Get latest offset (number of messages in topic)
  if [ -n "$KAFKA_POD" ]; then
    MSG_COUNT=$(kubectl exec -n minego "$KAFKA_POD" -- kafka-run-class.sh kafka.tools.GetOffsetShell \
      --broker-list "$KAFKA_BROKERS" \
      --topic "$topic" \
      --time -1 2>/dev/null | awk -F: '{sum+=$3} END {print sum}' || echo "0")
  else
    MSG_COUNT=$(kafka-run-class.sh kafka.tools.GetOffsetShell \
      --broker-list "$KAFKA_BROKERS" \
      --topic "$topic" \
      --time -1 2>/dev/null | awk -F: '{sum+=$3} END {print sum}' || echo "0")
  fi
  
  if [ "$MSG_COUNT" -gt 0 ]; then
    echo -e "  ${RED}✗ Messages found: $MSG_COUNT${NC}"
    TOTAL_MESSAGES=$((TOTAL_MESSAGES + MSG_COUNT))
    ALERT_NEEDED=true
    
    # Show sample message
    echo "  Latest message (first 500 chars):"
    if [ -n "$KAFKA_POD" ]; then
      kubectl exec -n minego "$KAFKA_POD" -- kafka-console-consumer.sh \
        --bootstrap-server "$KAFKA_BROKERS" \
        --topic "$topic" \
        --from-beginning \
        --max-messages 1 \
        --timeout-ms 5000 2>/dev/null | head -c 500
    else
      kafka-console-consumer.sh \
        --bootstrap-server "$KAFKA_BROKERS" \
        --topic "$topic" \
        --from-beginning \
        --max-messages 1 \
        --timeout-ms 5000 2>/dev/null | head -c 500
    fi
    echo ""
  else
    echo -e "  ${GREEN}✓ No messages${NC}"
  fi
  echo ""
done

# Summary
echo "=== Summary ==="
echo "Total DLQ messages: $TOTAL_MESSAGES"
echo ""

if [ "$ALERT_NEEDED" = true ]; then
  echo -e "${RED}⚠ ALERT: Dead Letter Queues contain failed events!${NC}"
  
  # Send alert to webhook if configured
  if [ -n "$ALERT_WEBHOOK" ]; then
    echo "Sending alert to webhook..."
    curl -X POST "$ALERT_WEBHOOK" \
      -H 'Content-Type: application/json' \
      -d "{
        \"text\": \"⚠ Kafka DLQ Alert\",
        \"attachments\": [{
          \"color\": \"danger\",
          \"fields\": [{
            \"title\": \"Total Failed Events\",
            \"value\": \"$TOTAL_MESSAGES\",
            \"short\": true
          }, {
            \"title\": \"Environment\",
            \"value\": \"${KAFKA_BROKERS}\",
            \"short\": true
          }]
        }]
      }"
  fi
  
  exit 1
else
  echo -e "${GREEN}✓ All DLQs are empty${NC}"
  exit 0
fi
