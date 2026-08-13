package taskschedule

import (
	"testing"
	"time"
)

func TestCronUsesLocalTimezoneAndSkipsSpringGap(t *testing.T) {
	cron, err := ParseCron("30 2 * * *", "America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	next, err := cron.Next(time.Date(2026, 3, 8, 6, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if want := time.Date(2026, 3, 9, 6, 30, 0, 0, time.UTC); !next.Equal(want) {
		t.Fatalf("next = %s want %s", next, want)
	}
}

func TestCronRunsRepeatedFallBackMinuteOnce(t *testing.T) {
	cron, err := ParseCron("30 1 * * *", "America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	first, _ := cron.Next(time.Date(2026, 11, 1, 4, 0, 0, 0, time.UTC))
	second, _ := cron.Next(first)
	if first.Hour() != 5 || second.Day() != 2 {
		t.Fatalf("fall-back occurrences = %s then %s", first, second)
	}
}
