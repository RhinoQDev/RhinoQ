package notification

import "time"

type Message struct {
	ID               string    `json:"id"`
	Type             string    `json:"type"`
	RuleID           string    `json:"ruleId"`
	SubjectType      string    `json:"subjectType"`
	SubjectID        string    `json:"subjectId"`
	InvariantVersion int       `json:"invariantVersion"`
	Status           string    `json:"status"`
	Severity         string    `json:"severity"`
	Escalation       bool      `json:"escalation"`
	Link             string    `json:"link,omitempty"`
	OccurrenceCount  int       `json:"occurrenceCount"`
	Evidence         string    `json:"evidence,omitempty"`
	ObservedAt       time.Time `json:"observedAt"`
}
