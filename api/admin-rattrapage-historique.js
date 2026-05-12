cat > /tmp/louvel-dryrun.json <<'EOF'
{
  "subscriptionId": "g5Cjcrn0BbgY3blvBrBL",
  "dryRun": true,
  "payments": [
    {"chargeDate":"2026-01-08","paidOutDate":"2026-01-12","amountGross":504.70},
    {"chargeDate":"2026-02-06","paidOutDate":"2026-02-10","amountGross":504.70},
    {"chargeDate":"2026-03-06","paidOutDate":"2026-03-10","amountGross":504.70},
    {"chargeDate":"2026-04-07","paidOutDate":"2026-04-09","amountGross":504.70},
    {"chargeDate":"2026-05-06","paidOutDate":"2026-05-11","amountGross":504.70}
  ]
}
EOF

curl -s -X POST https://team.alteore.com/api/admin-rattrapage-historique -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d @/tmp/louvel-dryrun.json | python3 -m json.tool
