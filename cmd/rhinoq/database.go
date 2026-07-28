package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func openDatabase(
	ctx context.Context,
	getenv func(string) string,
) (*sql.DB, error) {
	databaseURL := getenv("RHINOQ_DATABASE_URL")
	if databaseURL == "" {
		return nil, errors.New(
			"RHINOQ_DATABASE_URL is empty; set it to the PostgreSQL database that stores RhinoQ",
		)
	}
	driver := getenv("RHINOQ_DATABASE_DRIVER")
	if driver == "" {
		driver = "pgx"
	}
	db, err := sql.Open(driver, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open PostgreSQL driver %q: %w", driver, err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("connect to PostgreSQL: %w", err)
	}
	return db, nil
}
