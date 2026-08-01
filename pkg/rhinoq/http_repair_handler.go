package rhinoq

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxRepairCallbackResponse = 64 << 10

// HTTPRepairHandler keeps repair correctness in Go while allowing the owning
// application to implement business-specific preview/apply/verify callbacks.
// The URL is deployment configuration, never browser input.
type HTTPRepairHandler struct {
	url    string
	secret []byte
	client *http.Client
}

type HTTPRepairHandlerOptions struct {
	URL               string
	Secret            string
	Timeout           time.Duration
	AllowInsecureHTTP bool
}

func NewHTTPRepairHandler(options HTTPRepairHandlerOptions) (*HTTPRepairHandler, error) {
	parsed, err := url.Parse(strings.TrimSpace(options.URL))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return nil, errors.New("repair callback URL must be an absolute HTTP(S) URL")
	}
	if parsed.User != nil || parsed.Fragment != "" {
		return nil, errors.New("repair callback URL must not contain credentials or a fragment")
	}
	if parsed.Scheme == "http" && !options.AllowInsecureHTTP && !isLoopbackHost(parsed.Hostname()) {
		return nil, errors.New("repair callback requires HTTPS outside loopback; set allowInsecureHTTP only for a private development network")
	}
	if len(options.Secret) < 32 {
		return nil, errors.New("repair callback secret must contain at least 32 bytes")
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &HTTPRepairHandler{url: parsed.String(), secret: []byte(options.Secret), client: &http.Client{Timeout: timeout}}, nil
}

type repairCallbackRequest struct {
	Action         string          `json:"action"`
	Finding        FindingKey      `json:"finding"`
	Parameters     json.RawMessage `json:"parameters,omitempty"`
	IdempotencyKey string          `json:"idempotencyKey,omitempty"`
}

func (h *HTTPRepairHandler) Preview(ctx context.Context, finding FindingKey, parameters json.RawMessage) (RepairPreview, error) {
	var result RepairPreview
	err := h.call(ctx, repairCallbackRequest{Action: "preview", Finding: finding, Parameters: parameters}, &result)
	if err == nil && (strings.TrimSpace(result.Summary) == "" || strings.TrimSpace(result.Precondition) == "") {
		err = errors.New("repair preview callback returned an empty summary or precondition")
	}
	return result, err
}

func (h *HTTPRepairHandler) Apply(ctx context.Context, finding FindingKey, parameters json.RawMessage, idempotencyKey string) (RepairApplyResult, error) {
	var result RepairApplyResult
	err := h.call(ctx, repairCallbackRequest{Action: "apply", Finding: finding, Parameters: parameters, IdempotencyKey: idempotencyKey}, &result)
	if err == nil && strings.TrimSpace(result.Outcome) == "" {
		err = errors.New("repair apply callback returned an empty outcome")
	}
	return result, err
}

func (h *HTTPRepairHandler) Verify(ctx context.Context, finding FindingKey, parameters json.RawMessage) (RepairVerification, error) {
	var result RepairVerification
	err := h.call(ctx, repairCallbackRequest{Action: "verify", Finding: finding, Parameters: parameters}, &result)
	return result, err
}

func (h *HTTPRepairHandler) call(ctx context.Context, payload repairCallbackRequest, destination any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-RhinoQ-Repair-Signature", "v1="+signRepairBody(h.secret, body))
	req.Header.Set("X-RhinoQ-Repair-Action", payload.Action)
	if payload.IdempotencyKey != "" {
		req.Header.Set("Idempotency-Key", payload.IdempotencyKey)
	}
	response, err := h.client.Do(req)
	if err != nil {
		return fmt.Errorf("repair callback %s: %w", payload.Action, err)
	}
	defer response.Body.Close()
	reader := io.LimitReader(response.Body, maxRepairCallbackResponse+1)
	raw, err := io.ReadAll(reader)
	if err != nil {
		return err
	}
	if len(raw) > maxRepairCallbackResponse {
		return errors.New("repair callback response exceeds 64 KiB")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("repair callback %s returned HTTP %d", payload.Action, response.StatusCode)
	}
	if err := json.Unmarshal(raw, destination); err != nil {
		return fmt.Errorf("repair callback %s returned invalid JSON: %w", payload.Action, err)
	}
	return nil
}

func signRepairBody(secret, body []byte) string {
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func isLoopbackHost(host string) bool {
	host = strings.Trim(host, "[]")
	return strings.EqualFold(host, "localhost") || host == "127.0.0.1" || host == "::1"
}
