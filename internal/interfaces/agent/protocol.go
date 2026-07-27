// Package agent exposes RhinoQ over HTTP so an application in any language can
// use it. The Agent keeps every correctness rule - claiming, leases, fencing,
// retries, the effect ledger - and an SDK only has to do four things: enqueue,
// receive work, report the result, and record effects. Duplicating lease logic
// per language is how a queue ends up with a different set of bugs in every
// SDK (specification 53).
package agent

import (
	"fmt"
	"strconv"
	"strings"
)

// ProtocolVersion is the wire contract version. The major part is a
// compatibility boundary; the minor part may add capabilities.
const ProtocolVersion = "1.0"

// Capabilities the Agent implements.
var ServerCapabilities = []string{
	"enqueue", "claim", "heartbeat", "fencing", "cancel", "effect", "batch-claim",
}

// RequiredClientCapabilities are the things an SDK must do itself. Without
// them the connection is refused rather than silently degraded: an SDK that
// cannot present a fencing token cannot be allowed to write job state.
var RequiredClientCapabilities = []string{"claim", "heartbeat", "fencing"}

// OptionalClientCapabilities may be missing. The connection still works, but
// the Agent says exactly what is turned off.
var OptionalClientCapabilities = []string{"cancel", "effect", "batch-claim"}

// Handshake is what an SDK sends when it connects.
type Handshake struct {
	ProtocolVersion string   `json:"protocolVersion"`
	Capabilities    []string `json:"capabilities"`
	PayloadCodec    string   `json:"payloadCodec,omitempty"`
	MaxMessageSize  int      `json:"maxMessageSize,omitempty"`
	Language        string   `json:"language,omitempty"`
	SDKVersion      string   `json:"sdkVersion,omitempty"`
}

// Negotiation results.
const (
	// Compatible means everything the Agent needs is present.
	Compatible = "compatible"
	// Degraded means the connection works with named features turned off. An
	// operator has to be able to see this, because a degraded worker behaves
	// differently from a healthy one.
	Degraded = "degraded"
	// Rejected means a core capability is missing.
	Rejected = "rejected"
)

// HandshakeResult is the Agent's answer.
type HandshakeResult struct {
	Result          string   `json:"result"`
	ProtocolVersion string   `json:"protocolVersion"`
	Capabilities    []string `json:"capabilities"`
	// Missing lists required capabilities the SDK did not offer.
	Missing []string `json:"missing,omitempty"`
	// Disabled lists optional features that will not be available.
	Disabled []string `json:"disabled,omitempty"`
	// Reason explains a rejection or a degradation in words an operator can act
	// on.
	Reason string `json:"reason,omitempty"`
	// HeartbeatIntervalMs is how often the Agent expects a lease renewal.
	HeartbeatIntervalMs int64 `json:"heartbeatIntervalMs"`
	MaxPayloadBytes     int   `json:"maxPayloadBytes"`
}

// Negotiate compares an SDK handshake against what the Agent needs. It answers
// with exactly one of compatible, degraded or rejected, and never guesses.
func Negotiate(handshake Handshake, heartbeatIntervalMs int64, maxPayloadBytes int) HandshakeResult {
	result := HandshakeResult{
		Result:              Compatible,
		ProtocolVersion:     ProtocolVersion,
		Capabilities:        ServerCapabilities,
		HeartbeatIntervalMs: heartbeatIntervalMs,
		MaxPayloadBytes:     maxPayloadBytes,
	}

	clientMajor, err := majorVersion(handshake.ProtocolVersion)
	if err != nil {
		result.Result = Rejected
		result.Reason = fmt.Sprintf("protocolVersion %q is not a version this Agent understands; send %q",
			handshake.ProtocolVersion, ProtocolVersion)
		return result
	}
	serverMajor, _ := majorVersion(ProtocolVersion)
	if clientMajor != serverMajor {
		result.Result = Rejected
		result.Reason = fmt.Sprintf("protocol major version %d is incompatible with this Agent (%s); upgrade the SDK",
			clientMajor, ProtocolVersion)
		return result
	}
	if codec := strings.ToLower(handshake.PayloadCodec); codec != "" && codec != "json" {
		result.Result = Rejected
		result.Reason = fmt.Sprintf("payloadCodec %q is not supported; this Agent speaks json", handshake.PayloadCodec)
		return result
	}

	offered := make(map[string]bool, len(handshake.Capabilities))
	for _, capability := range handshake.Capabilities {
		offered[strings.ToLower(strings.TrimSpace(capability))] = true
	}
	for _, required := range RequiredClientCapabilities {
		if !offered[required] {
			result.Missing = append(result.Missing, required)
		}
	}
	if len(result.Missing) > 0 {
		result.Result = Rejected
		result.Reason = fmt.Sprintf("the SDK does not implement %s, which RhinoQ cannot do on its behalf; upgrade the SDK",
			strings.Join(result.Missing, ", "))
		return result
	}
	for _, optional := range OptionalClientCapabilities {
		if !offered[optional] {
			result.Disabled = append(result.Disabled, optional)
		}
	}
	if len(result.Disabled) > 0 {
		result.Result = Degraded
		result.Reason = fmt.Sprintf("connected without %s; %s",
			strings.Join(result.Disabled, ", "), degradationEffect(result.Disabled))
	}
	return result
}

func degradationEffect(disabled []string) string {
	effects := make([]string, 0, len(disabled))
	for _, capability := range disabled {
		switch capability {
		case "cancel":
			effects = append(effects, "cancellation only takes effect when the lease expires")
		case "effect":
			effects = append(effects, "external effects are not recorded, so uncertainty cannot be detected")
		case "batch-claim":
			effects = append(effects, "jobs are claimed one at a time")
		}
	}
	return strings.Join(effects, "; ")
}

func majorVersion(version string) (int, error) {
	parts := strings.SplitN(strings.TrimSpace(version), ".", 2)
	if parts[0] == "" {
		return 0, fmt.Errorf("empty protocol version")
	}
	return strconv.Atoi(parts[0])
}
