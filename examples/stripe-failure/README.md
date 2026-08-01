# Stripe response-loss demo

Run `go run ./examples/stripe-failure`. The local Stripe-shaped provider stores
the refund and then aborts the HTTP response. RhinoQ reads the provider back,
confirms the operation and prevents the repeated call from sending a second
refund. No Stripe account or secret is used.
