package notification

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

	notificationcontract "github.com/madebyduy/RhinoQ/internal/contracts/notification"
)

type Kind string

const (
	Webhook Kind = "webhook"
	Slack   Kind = "slack"
)

type Config struct {
	URL     string
	Kind    Kind
	Secret  string
	Timeout time.Duration
	Client  *http.Client
}
type Sender struct {
	url    string
	kind   Kind
	secret []byte
	client *http.Client
}

func New(config Config) (*Sender, error) {
	parsed, err := url.Parse(config.URL)
	if err != nil || parsed.Host == "" {
		return nil, errors.New("notification URL is invalid")
	}
	host := parsed.Hostname()
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && (host == "localhost" || net.ParseIP(host).IsLoopback())) {
		return nil, errors.New("notification URL must use HTTPS (HTTP is allowed only for loopback tests)")
	}
	if config.Kind == "" {
		config.Kind = Webhook
	}
	if config.Kind != Webhook && config.Kind != Slack {
		return nil, errors.New("notification kind must be webhook or slack")
	}
	if config.Timeout <= 0 {
		config.Timeout = 10 * time.Second
	}
	client := config.Client
	if client == nil {
		client = &http.Client{Timeout: config.Timeout}
	}
	return &Sender{url: config.URL, kind: config.Kind, secret: []byte(config.Secret), client: client}, nil
}

func (s *Sender) Send(ctx context.Context, message notificationcontract.Message) error {
	body, err := s.body(message)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "RhinoQ-Notifier/0.1")
	request.Header.Set("X-RhinoQ-Event-Id", message.ID)
	if len(s.secret) > 0 {
		mac := hmac.New(sha256.New, s.secret)
		_, _ = mac.Write(body)
		request.Header.Set("X-RhinoQ-Signature", "v1="+hex.EncodeToString(mac.Sum(nil)))
	}
	response, err := s.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("notification endpoint returned %s", response.Status)
	}
	return nil
}

func (s *Sender) body(message notificationcontract.Message) ([]byte, error) {
	if s.kind == Webhook {
		return json.Marshal(message)
	}
	text := fmt.Sprintf("RhinoQ finding %s: %s/%s %s is %s (%d sightings)",
		message.ID, message.SubjectType, message.SubjectID, message.RuleID, message.Status, message.OccurrenceCount)
	if message.Evidence != "" {
		text += "\nEvidence: " + strings.ReplaceAll(message.Evidence, "\n", " ")
	}
	if message.Link != "" {
		text += "\nOpen: " + message.Link
	}
	return json.Marshal(map[string]any{"text": text, "blocks": []map[string]any{{
		"type": "section", "text": map[string]string{"type": "mrkdwn", "text": text},
	}}})
}
