package telemetry

import (
	"fmt"
	"strconv"
	"strings"
)

// RenderHistogram writes one histogram in the Prometheus text exposition
// format.
//
// The format is unforgiving in ways that are easy to get wrong and hard to
// notice: the +Inf bucket is mandatory and must equal _count, bucket counts must
// be cumulative, and a scrape with one malformed line is rejected whole rather
// than in part. Keeping the rendering in one tested function is what stops a
// silently-dropped metrics endpoint.
func RenderHistogram(out *strings.Builder, name, help string, snapshot HistogramSnapshot, extraLabels ...string) {
	fmt.Fprintf(out, "# HELP %s %s\n# TYPE %s histogram\n", name, help, name)
	writeHistogramSamples(out, name, snapshot, extraLabels...)
}

// RenderHistogramVec writes every series of a vector under one HELP/TYPE pair,
// which the format requires: repeating them per series makes the metric family
// invalid.
func RenderHistogramVec(out *strings.Builder, name, help, labelName string, series []LabelledSnapshot) {
	fmt.Fprintf(out, "# HELP %s %s\n# TYPE %s histogram\n", name, help, name)
	for _, item := range series {
		writeHistogramSamples(out, name, item.Snapshot, labelName, item.Label)
	}
}

func writeHistogramSamples(out *strings.Builder, name string, snapshot HistogramSnapshot, extraLabels ...string) {
	prefix := labelPrefix(extraLabels...)
	for i, bound := range snapshot.Bounds {
		fmt.Fprintf(out, "%s_bucket{%sle=%q} %d\n",
			name, prefix, formatBound(bound), snapshot.Cumulative[i])
	}
	// The +Inf bucket is read from Count rather than from the last cumulative
	// entry. They are the same number by construction, and using Count means a
	// torn read can never publish a +Inf bucket below _count, which is the one
	// inconsistency Prometheus treats as corrupt data rather than as noise.
	fmt.Fprintf(out, "%s_bucket{%sle=\"+Inf\"} %d\n", name, prefix, snapshot.Count)
	fmt.Fprintf(out, "%s_sum{%s} %s\n", name, trimTrailingComma(prefix), formatFloat(snapshot.Sum))
	fmt.Fprintf(out, "%s_count{%s} %d\n", name, trimTrailingComma(prefix), snapshot.Count)
}

// labelPrefix renders label pairs with a trailing comma so an le label can
// follow. Pairs are taken as name/value; an odd tail is dropped rather than
// rendered as a label with no value, which would invalidate the scrape.
func labelPrefix(pairs ...string) string {
	if len(pairs) < 2 {
		return ""
	}
	var builder strings.Builder
	for i := 0; i+1 < len(pairs); i += 2 {
		fmt.Fprintf(&builder, "%s=%q,", pairs[i], escapeLabelValue(pairs[i+1]))
	}
	return builder.String()
}

func trimTrailingComma(prefix string) string {
	return strings.TrimSuffix(prefix, ",")
}

// escapeLabelValue guards the exposition format against a label value carrying a
// quote, backslash or newline. Queue names and route patterns are the values
// here, and a newline in one would let a label inject an entire fake metric
// line.
func escapeLabelValue(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`)
	return replacer.Replace(value)
}

// formatBound renders a bucket boundary the way Prometheus conventionally does:
// the shortest representation that round-trips, so 0.5 is "0.5" and not
// "0.500000".
func formatBound(bound float64) string {
	return strconv.FormatFloat(bound, 'g', -1, 64)
}

func formatFloat(value float64) string {
	return strconv.FormatFloat(value, 'g', -1, 64)
}
