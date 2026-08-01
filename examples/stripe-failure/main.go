// stripe-failure demonstrates the dangerous payment case: the provider accepts
// a refund, then the connection disappears before the client sees a response.
// The server is local and Stripe-shaped, so the demo needs no secret key.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"

	"github.com/madebyduy/RhinoQ/pkg/rhinoq"
)

func main() {
	provider := newStripeLikeProvider()
	defer provider.Close()
	client := rhinoq.NewInMemory()
	request := rhinoq.ProviderOperationRequest{
		Provider: "stripe", Operation: "refund", IdempotencyKey: "refund_order_42",
		Confirmation: rhinoq.ProviderConfirmByReadback,
	}
	run := func(ctx context.Context, key string) (rhinoq.ProviderAcceptance, error) {
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, provider.URL+"/v1/refunds", nil)
		req.Header.Set("Idempotency-Key", key)
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			return rhinoq.ProviderAcceptance{}, err
		}
		defer response.Body.Close()
		return rhinoq.ProviderAcceptance{ProviderID: response.Header.Get("Stripe-Request-Id")}, nil
	}
	verify := func(ctx context.Context, operation rhinoq.ProviderOperationRecord) (rhinoq.ProviderConfirmation, error) {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet,
			provider.URL+"/v1/refunds?key="+operation.IdempotencyKey, nil)
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			return rhinoq.ProviderConfirmation{}, err
		}
		defer response.Body.Close()
		var result struct{ ID, Status string }
		if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
			return rhinoq.ProviderConfirmation{}, err
		}
		return rhinoq.ProviderConfirmation{Decision: rhinoq.ProviderConfirmed,
			Evidence: result.ID + ":" + result.Status}, nil
	}

	result, err := client.ProviderOperation(context.Background(), request, run, verify)
	if err != nil {
		panic(err)
	}
	fmt.Printf("state=%s evidence=%s provider_calls=%d\n", result.State, result.Evidence, provider.calls())
	result, err = client.ProviderOperation(context.Background(), request, run, verify)
	if err != nil {
		panic(err)
	}
	fmt.Printf("repeat_state=%s provider_calls=%d (still one)\n", result.State, provider.calls())
}

type stripeLikeProvider struct {
	*httptest.Server
	mu        sync.Mutex
	refunds   map[string]string
	callCount int
}

func newStripeLikeProvider() *stripeLikeProvider {
	p := &stripeLikeProvider{refunds: map[string]string{}}
	p.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Header.Get("Idempotency-Key")
		if r.Method == http.MethodPost {
			p.mu.Lock()
			p.callCount++
			p.refunds[key] = "re_demo_42"
			p.mu.Unlock()
			// The provider committed the refund, but the connection dies before a
			// response. A blind retry would be unsafe without the same key/readback.
			panic(http.ErrAbortHandler)
		}
		p.mu.Lock()
		id := p.refunds[r.URL.Query().Get("key")]
		p.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]string{"ID": id, "Status": "succeeded"})
	}))
	return p
}
func (p *stripeLikeProvider) calls() int { p.mu.Lock(); defer p.mu.Unlock(); return p.callCount }
