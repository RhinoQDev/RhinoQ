package taskschedule

import (
	"strconv"
	"strings"
	"time"
)

// Cron is a standard five-field minute/hour/day/month/weekday calendar in an
// IANA timezone. Spring-forward gaps are skipped; repeated fall-back wall
// minutes run once (the first occurrence).
type Cron struct {
	expression string
	location   *time.Location
	fields     [5]map[int]bool
}

func ParseCron(expression, timezone string) (Cron, error) {
	parts := strings.Fields(expression)
	location, err := time.LoadLocation(strings.TrimSpace(timezone))
	if len(parts) != 5 || err != nil || strings.TrimSpace(timezone) == "" {
		return Cron{}, ErrInvalid
	}
	ranges := [5][2]int{{0, 59}, {0, 23}, {1, 31}, {1, 12}, {0, 7}}
	var fields [5]map[int]bool
	for i, part := range parts {
		fields[i], err = cronField(part, ranges[i][0], ranges[i][1], i == 4)
		if err != nil {
			return Cron{}, ErrInvalid
		}
	}
	return Cron{expression: strings.Join(parts, " "), location: location, fields: fields}, nil
}

func (c Cron) Next(after time.Time) (time.Time, error) {
	if after.IsZero() || c.location == nil {
		return time.Time{}, ErrInvalid
	}
	previousWall := after.In(c.location).Format("2006-01-02 15:04")
	candidate := after.UTC().Truncate(time.Minute).Add(time.Minute)
	limit := candidate.AddDate(2, 0, 0)
	for !candidate.After(limit) {
		local := candidate.In(c.location)
		wall := local.Format("2006-01-02 15:04")
		weekday := int(local.Weekday())
		if wall != previousWall && c.fields[0][local.Minute()] && c.fields[1][local.Hour()] && c.fields[2][local.Day()] && c.fields[3][int(local.Month())] && c.fields[4][weekday] {
			return candidate, nil
		}
		candidate = candidate.Add(time.Minute)
	}
	return time.Time{}, ErrInvalid
}

func cronField(raw string, min, max int, weekday bool) (map[int]bool, error) {
	values := map[int]bool{}
	for _, item := range strings.Split(raw, ",") {
		base, stepRaw, hasStep := strings.Cut(item, "/")
		step := 1
		var err error
		if hasStep {
			step, err = strconv.Atoi(stepRaw)
			if err != nil || step < 1 {
				return nil, ErrInvalid
			}
		}
		start, end := min, max
		if base != "*" {
			left, right, ranged := strings.Cut(base, "-")
			start, err = strconv.Atoi(left)
			if err != nil {
				return nil, ErrInvalid
			}
			end = start
			if ranged {
				end, err = strconv.Atoi(right)
				if err != nil {
					return nil, ErrInvalid
				}
			}
		}
		if start < min || end > max || start > end {
			return nil, ErrInvalid
		}
		for value := start; value <= end; value += step {
			normalized := value
			if weekday && normalized == 7 {
				normalized = 0
			}
			values[normalized] = true
		}
	}
	if len(values) == 0 {
		return nil, ErrInvalid
	}
	return values, nil
}
