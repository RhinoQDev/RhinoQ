// Package diagnostic carries the shape every operator-facing RhinoQ error must
// have. An error that only says what broke costs the reader a support round
// trip; specification 17.2 requires five parts instead.
package diagnostic

import "strings"

// Message is the five-part error contract: what happened, why it matters, what
// RhinoQ already did about it, the exact fix, and the command that proves the
// fix worked.
type Message struct {
	Code          string
	WhatHappened  string
	WhyItMatters  string
	WhatRhinoQDid string
	HowToFix      string
	Verify        string
}

func (m Message) Error() string { return m.String() }

func (m Message) String() string {
	var builder strings.Builder
	builder.WriteString(m.Code)
	section(&builder, "What happened", m.WhatHappened)
	section(&builder, "Why it matters", m.WhyItMatters)
	section(&builder, "What RhinoQ did", m.WhatRhinoQDid)
	section(&builder, "How to fix", m.HowToFix)
	section(&builder, "Verify", m.Verify)
	return builder.String()
}

func section(builder *strings.Builder, title, body string) {
	if strings.TrimSpace(body) == "" {
		return
	}
	builder.WriteString("\n\n")
	builder.WriteString(title)
	for _, line := range strings.Split(strings.TrimRight(body, "\n"), "\n") {
		builder.WriteString("\n  ")
		builder.WriteString(line)
	}
}
