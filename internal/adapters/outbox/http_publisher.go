package outbox

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/madebyduy/RhinoQ/internal/ports"
)

type HTTPPublisherConfig struct {
	URL     string
	Secret  string
	Timeout time.Duration
	Client  *http.Client
}

type HTTPPublisher struct {
	url    string
	secret []byte
	client *http.Client
}

func NewHTTPPublisher(config HTTPPublisherConfig) (*HTTPPublisher, error) {
	parsed, err := url.Parse(config.URL)
	if err != nil || parsed.Host == "" {
		return nil, errors.New("outbox dispatch URL is invalid")
	}
	host := parsed.Hostname()
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && (host == "localhost" || (net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback()))) {
		return nil, errors.New("outbox dispatch URL must use HTTPS (HTTP is allowed only for loopback)")
	}
	if strings.TrimSpace(config.Secret) == "" {
		return nil, errors.New("outbox dispatch secret is required")
	}
	if config.Timeout <= 0 {
		config.Timeout = 10 * time.Second
	}
	client := config.Client
	if client == nil {
		client = &http.Client{Timeout: config.Timeout}
	}
	return &HTTPPublisher{url: config.URL, secret: []byte(config.Secret), client: client}, nil
}

func (p *HTTPPublisher) Publish(ctx context.Context, event ports.OutboxEvent) error {
	if event.ID <= 0 || event.EventType == "" || !json.Valid(event.Payload) {
		return errors.New("valid outbox event is required")
	}
	body, err := json.Marshal(struct {
		ID        int64           `json:"id"`
		EventType string          `json:"eventType"`
		Payload   json.RawMessage `json:"payload"`
	}{event.ID, event.EventType, event.Payload})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, p.url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	mac := hmac.New(sha256.New, p.secret)
	_, _ = mac.Write(body)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "RhinoQ-Outbox/1")
	request.Header.Set("X-RhinoQ-Event-Id", fmt.Sprint(event.ID))
	request.Header.Set("X-RhinoQ-Signature", "v1="+hex.EncodeToString(mac.Sum(nil)))
	response, err := p.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("outbox dispatch endpoint returned %s", response.Status)
	}
	return nil
}
