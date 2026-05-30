package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
	_ "modernc.org/sqlite"
)

var (
	ErrConflict            = errors.New("subi store: conflict")
	ErrInsufficientCredits = errors.New("subi store: insufficient credits")
	ErrInvalid             = errors.New("subi store: invalid input")
	ErrNotFound            = errors.New("subi store: not found")
	ErrUnauthorized        = errors.New("subi store: unauthorized")
)

const CreditMicrosPerCredit int64 = 1_000_000

type Store struct {
	db *sql.DB
}

type User struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
}

type BuyerAPIKey struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	KeyPrefix  string     `json:"key_prefix"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
	RevokedAt  *time.Time `json:"revoked_at,omitempty"`
}

type CreatedBuyerAPIKey struct {
	BuyerAPIKey
	Secret string `json:"secret"`
}

type AuthenticatedBuyerKey struct {
	ID      string
	UserID  string
	KeyHash string
}

type SellerNode struct {
	ID             string     `json:"id"`
	SellerUserID   string     `json:"seller_user_id,omitempty"`
	NodeID         string     `json:"node_id"`
	Status         string     `json:"status"`
	Provider       string     `json:"provider"`
	MaxConcurrency int        `json:"max_concurrency"`
	LastSeenAt     *time.Time `json:"last_seen_at,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
}

type SellerSetupToken struct {
	Token     string    `json:"setup_token"`
	ExpiresAt time.Time `json:"expires_at"`
}

type SellerSetupConfig struct {
	NodeID         string
	NodeToken      string
	MaxConcurrency int
	Provider       string
}

type CreditWallet struct {
	BuyerUserID   string    `json:"buyer_user_id,omitempty"`
	BalanceMicros int64     `json:"balance_micros"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type CreditLedgerEntry struct {
	ID                 string    `json:"id"`
	BuyerUserID        string    `json:"buyer_user_id,omitempty"`
	Type               string    `json:"type"`
	AmountMicros       int64     `json:"amount_micros"`
	BalanceAfterMicros int64     `json:"balance_after_micros"`
	RequestID          string    `json:"request_id,omitempty"`
	Note               string    `json:"note,omitempty"`
	CreatedAt          time.Time `json:"created_at"`
}

type CreditOrder struct {
	ID           string     `json:"id"`
	BuyerUserID  string     `json:"buyer_user_id,omitempty"`
	AmountMicros int64      `json:"amount_micros"`
	Status       string     `json:"status"`
	CreatedAt    time.Time  `json:"created_at"`
	PaidAt       *time.Time `json:"paid_at,omitempty"`
}

type RequestFill struct {
	RequestID           string    `json:"request_id"`
	BuyerUserID         string    `json:"buyer_user_id,omitempty"`
	BuyerAPIKeyID       string    `json:"buyer_api_key_id,omitempty"`
	SellerNodeID        string    `json:"seller_node_id,omitempty"`
	Path                string    `json:"path"`
	StatusCode          int       `json:"status"`
	Stream              bool      `json:"stream"`
	DurationMS          int64     `json:"duration_ms"`
	TimeToFirstChunkMS  int64     `json:"time_to_first_chunk_ms"`
	BytesOut            int64     `json:"bytes_out"`
	CostMicros          int64     `json:"cost_micros"`
	SellerEarningMicros int64     `json:"seller_earning_micros"`
	PlatformFeeMicros   int64     `json:"platform_fee_micros"`
	ReserveMicros       int64     `json:"reserve_micros"`
	Error               string    `json:"error,omitempty"`
	CreatedAt           time.Time `json:"created_at"`
}

type SellerEarningsSummary struct {
	SellerUserID          string `json:"seller_user_id,omitempty"`
	BalanceMicros         int64  `json:"balance_micros"`
	TotalEarnedMicros     int64  `json:"total_earned_micros"`
	TotalPaidOutMicros    int64  `json:"total_paid_out_micros"`
	AvailablePayoutMicros int64  `json:"available_payout_micros"`
}

type SellerEarningLedgerEntry struct {
	ID                 string    `json:"id"`
	SellerUserID       string    `json:"seller_user_id,omitempty"`
	SellerNodeID       string    `json:"seller_node_id,omitempty"`
	Type               string    `json:"type"`
	AmountMicros       int64     `json:"amount_micros"`
	BalanceAfterMicros int64     `json:"balance_after_micros"`
	RequestID          string    `json:"request_id,omitempty"`
	Note               string    `json:"note,omitempty"`
	CreatedAt          time.Time `json:"created_at"`
}

type RequestFillInput struct {
	RequestID           string
	BuyerUserID         string
	BuyerAPIKeyID       string
	SellerNodeID        string
	Path                string
	StatusCode          int
	Stream              bool
	DurationMS          int64
	TimeToFirstChunkMS  int64
	BytesOut            int64
	CostMicros          int64
	SellerEarningMicros int64
	PlatformFeeMicros   int64
	ReserveMicros       int64
	Error               string
}

func Open(path string) (*Store, error) {
	if strings.TrimSpace(path) == "" {
		return nil, ErrInvalid
	}
	dsn := "file:" + path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(ON)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	store := &Store{db: db}
	if err := store.migrate(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) RegisterUser(ctx context.Context, email, password string) (User, error) {
	email, err := normalizeEmail(email)
	if err != nil {
		return User{}, err
	}
	if len(password) < 8 {
		return User{}, fmt.Errorf("%w: password must be at least 8 characters", ErrInvalid)
	}
	passwordHash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return User{}, err
	}
	now := time.Now().UTC()
	user := User{
		ID:        newID("usr"),
		Email:     email,
		Status:    "active",
		CreatedAt: now,
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, err
	}
	defer rollback(tx)

	_, err = tx.ExecContext(ctx, `
INSERT INTO users (id, email, password_hash, status, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?)`,
		user.ID, user.Email, string(passwordHash), user.Status, now, now,
	)
	if err != nil {
		if isUniqueErr(err) {
			return User{}, ErrConflict
		}
		return User{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO buyer_profiles (user_id, created_at) VALUES (?, ?)`, user.ID, now); err != nil {
		return User{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO seller_profiles (user_id, created_at) VALUES (?, ?)`, user.ID, now); err != nil {
		return User{}, err
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO credit_wallets (buyer_user_id, balance_micros, created_at, updated_at)
VALUES (?, 0, ?, ?)`, user.ID, now, now); err != nil {
		return User{}, err
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO seller_earning_wallets (seller_user_id, balance_micros, created_at, updated_at)
VALUES (?, 0, ?, ?)`, user.ID, now, now); err != nil {
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, err
	}
	return user, nil
}

func (s *Store) AuthenticateUser(ctx context.Context, email, password string) (User, error) {
	email, err := normalizeEmail(email)
	if err != nil {
		return User{}, ErrUnauthorized
	}
	var user User
	var passwordHash string
	err = s.db.QueryRowContext(ctx, `
SELECT id, email, password_hash, status, created_at
FROM users
WHERE email = ? AND status = 'active'`,
		email,
	).Scan(&user.ID, &user.Email, &passwordHash, &user.Status, &user.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrUnauthorized
	}
	if err != nil {
		return User{}, err
	}
	if bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(password)) != nil {
		return User{}, ErrUnauthorized
	}
	return user, nil
}

func (s *Store) CreateWebSession(ctx context.Context, userID string, ttl time.Duration) (string, time.Time, error) {
	if ttl <= 0 {
		ttl = 7 * 24 * time.Hour
	}
	secret := newSecret("subi_sess")
	now := time.Now().UTC()
	expiresAt := now.Add(ttl)
	_, err := s.db.ExecContext(ctx, `
INSERT INTO web_sessions (id, user_id, session_token_hash, expires_at, created_at)
VALUES (?, ?, ?, ?, ?)`,
		newID("sess"), userID, HashSecret(secret), expiresAt, now,
	)
	if err != nil {
		return "", time.Time{}, err
	}
	return secret, expiresAt, nil
}

func (s *Store) UserBySession(ctx context.Context, sessionSecret string) (User, error) {
	if strings.TrimSpace(sessionSecret) == "" {
		return User{}, ErrUnauthorized
	}
	var user User
	err := s.db.QueryRowContext(ctx, `
SELECT u.id, u.email, u.status, u.created_at
FROM web_sessions ws
JOIN users u ON u.id = ws.user_id
WHERE ws.session_token_hash = ? AND ws.expires_at > ? AND u.status = 'active'`,
		HashSecret(sessionSecret), time.Now().UTC(),
	).Scan(&user.ID, &user.Email, &user.Status, &user.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrUnauthorized
	}
	if err != nil {
		return User{}, err
	}
	return user, nil
}

func (s *Store) DeleteWebSession(ctx context.Context, sessionSecret string) error {
	if strings.TrimSpace(sessionSecret) == "" {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM web_sessions WHERE session_token_hash = ?`, HashSecret(sessionSecret))
	return err
}

func (s *Store) CreateBuyerAPIKey(ctx context.Context, userID, name string) (CreatedBuyerAPIKey, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "Default key"
	}
	secret := newSecret("sk-subi")
	now := time.Now().UTC()
	key := CreatedBuyerAPIKey{
		BuyerAPIKey: BuyerAPIKey{
			ID:        newID("bak"),
			Name:      name,
			KeyPrefix: secretPrefix(secret),
			CreatedAt: now,
		},
		Secret: secret,
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO buyer_api_keys (id, buyer_user_id, name, key_hash, key_prefix, created_at)
VALUES (?, ?, ?, ?, ?, ?)`,
		key.ID, userID, key.Name, HashSecret(secret), key.KeyPrefix, key.CreatedAt,
	)
	if err != nil {
		return CreatedBuyerAPIKey{}, err
	}
	return key, nil
}

func (s *Store) ListBuyerAPIKeys(ctx context.Context, userID string) ([]BuyerAPIKey, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, name, key_prefix, created_at, last_used_at, revoked_at
FROM buyer_api_keys
WHERE buyer_user_id = ?
ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []BuyerAPIKey
	for rows.Next() {
		var key BuyerAPIKey
		if err := rows.Scan(&key.ID, &key.Name, &key.KeyPrefix, &key.CreatedAt, &key.LastUsedAt, &key.RevokedAt); err != nil {
			return nil, err
		}
		out = append(out, key)
	}
	return out, rows.Err()
}

func (s *Store) RevokeBuyerAPIKey(ctx context.Context, userID, keyID string) error {
	res, err := s.db.ExecContext(ctx, `
UPDATE buyer_api_keys
SET revoked_at = COALESCE(revoked_at, ?)
WHERE id = ? AND buyer_user_id = ?`,
		time.Now().UTC(), keyID, userID,
	)
	if err != nil {
		return err
	}
	return requireRows(res)
}

func (s *Store) AuthenticateBuyerAPIKey(ctx context.Context, secret string) (AuthenticatedBuyerKey, error) {
	keyHash := HashSecret(secret)
	var key AuthenticatedBuyerKey
	err := s.db.QueryRowContext(ctx, `
SELECT id, buyer_user_id, key_hash
FROM buyer_api_keys
WHERE key_hash = ? AND revoked_at IS NULL`,
		keyHash,
	).Scan(&key.ID, &key.UserID, &key.KeyHash)
	if errors.Is(err, sql.ErrNoRows) {
		return AuthenticatedBuyerKey{}, ErrUnauthorized
	}
	if err != nil {
		return AuthenticatedBuyerKey{}, err
	}
	_, _ = s.db.ExecContext(ctx, `UPDATE buyer_api_keys SET last_used_at = ? WHERE id = ?`, time.Now().UTC(), key.ID)
	return key, nil
}

func (s *Store) GetBuyerCreditWallet(ctx context.Context, userID string) (CreditWallet, error) {
	if err := s.ensureBuyerWallet(ctx, userID); err != nil {
		return CreditWallet{}, err
	}
	var wallet CreditWallet
	err := s.db.QueryRowContext(ctx, `
SELECT buyer_user_id, balance_micros, created_at, updated_at
FROM credit_wallets
WHERE buyer_user_id = ?`, userID).Scan(&wallet.BuyerUserID, &wallet.BalanceMicros, &wallet.CreatedAt, &wallet.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return CreditWallet{}, ErrNotFound
	}
	if err != nil {
		return CreditWallet{}, err
	}
	return wallet, nil
}

func (s *Store) CreateMockCreditOrder(ctx context.Context, userID string, amountMicros int64) (CreditOrder, CreditLedgerEntry, CreditWallet, error) {
	if amountMicros <= 0 {
		return CreditOrder{}, CreditLedgerEntry{}, CreditWallet{}, ErrInvalid
	}
	now := time.Now().UTC()
	order := CreditOrder{
		ID:           newID("co"),
		BuyerUserID:  userID,
		AmountMicros: amountMicros,
		Status:       "paid",
		CreatedAt:    now,
		PaidAt:       &now,
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return CreditOrder{}, CreditLedgerEntry{}, CreditWallet{}, err
	}
	defer rollback(tx)

	if err := ensureBuyerWalletTx(ctx, tx, userID); err != nil {
		return CreditOrder{}, CreditLedgerEntry{}, CreditWallet{}, err
	}
	balance, err := buyerWalletBalanceForUpdate(ctx, tx, userID)
	if err != nil {
		return CreditOrder{}, CreditLedgerEntry{}, CreditWallet{}, err
	}
	nextBalance := balance + amountMicros
	ledger := CreditLedgerEntry{
		ID:                 newID("cle"),
		BuyerUserID:        userID,
		Type:               "recharge",
		AmountMicros:       amountMicros,
		BalanceAfterMicros: nextBalance,
		Note:               "mock credit recharge",
		CreatedAt:          now,
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO credit_orders (id, buyer_user_id, amount_micros, status, created_at, paid_at)
VALUES (?, ?, ?, ?, ?, ?)`,
		order.ID, order.BuyerUserID, order.AmountMicros, order.Status, order.CreatedAt, order.PaidAt,
	); err != nil {
		return CreditOrder{}, CreditLedgerEntry{}, CreditWallet{}, err
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE credit_wallets
SET balance_micros = ?, updated_at = ?
WHERE buyer_user_id = ?`, nextBalance, now, userID); err != nil {
		return CreditOrder{}, CreditLedgerEntry{}, CreditWallet{}, err
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO credit_ledger_entries (id, buyer_user_id, type, amount_micros, balance_after_micros, request_id, note, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		ledger.ID, ledger.BuyerUserID, ledger.Type, ledger.AmountMicros, ledger.BalanceAfterMicros, ledger.RequestID, ledger.Note, ledger.CreatedAt,
	); err != nil {
		return CreditOrder{}, CreditLedgerEntry{}, CreditWallet{}, err
	}
	if err := tx.Commit(); err != nil {
		return CreditOrder{}, CreditLedgerEntry{}, CreditWallet{}, err
	}
	return order, ledger, CreditWallet{BuyerUserID: userID, BalanceMicros: nextBalance, CreatedAt: now, UpdatedAt: now}, nil
}

func (s *Store) ReserveBuyerCreditsForRequest(ctx context.Context, userID, requestID string, amountMicros int64, note string) (CreditLedgerEntry, CreditWallet, error) {
	requestID = strings.TrimSpace(requestID)
	if strings.TrimSpace(userID) == "" || requestID == "" || amountMicros <= 0 {
		return CreditLedgerEntry{}, CreditWallet{}, ErrInvalid
	}
	now := time.Now().UTC()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return CreditLedgerEntry{}, CreditWallet{}, err
	}
	defer rollback(tx)

	existing, err := creditLedgerByRequestTypeTx(ctx, tx, userID, requestID, "debit")
	if err == nil {
		wallet, walletErr := buyerWalletTx(ctx, tx, userID)
		if walletErr != nil {
			return CreditLedgerEntry{}, CreditWallet{}, walletErr
		}
		if err := tx.Commit(); err != nil {
			return CreditLedgerEntry{}, CreditWallet{}, err
		}
		return existing, wallet, nil
	}
	if err != nil && !errors.Is(err, ErrNotFound) {
		return CreditLedgerEntry{}, CreditWallet{}, err
	}
	if err := ensureBuyerWalletTx(ctx, tx, userID); err != nil {
		return CreditLedgerEntry{}, CreditWallet{}, err
	}
	balance, err := buyerWalletBalanceForUpdate(ctx, tx, userID)
	if err != nil {
		return CreditLedgerEntry{}, CreditWallet{}, err
	}
	if balance < amountMicros {
		return CreditLedgerEntry{}, CreditWallet{}, ErrInsufficientCredits
	}
	nextBalance := balance - amountMicros
	ledger := CreditLedgerEntry{
		ID:                 newID("cle"),
		BuyerUserID:        userID,
		Type:               "debit",
		AmountMicros:       -amountMicros,
		BalanceAfterMicros: nextBalance,
		RequestID:          requestID,
		Note:               strings.TrimSpace(note),
		CreatedAt:          now,
	}
	if ledger.Note == "" {
		ledger.Note = "request pre-authorization"
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE credit_wallets
SET balance_micros = ?, updated_at = ?
WHERE buyer_user_id = ?`, nextBalance, now, userID); err != nil {
		return CreditLedgerEntry{}, CreditWallet{}, err
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO credit_ledger_entries (id, buyer_user_id, type, amount_micros, balance_after_micros, request_id, note, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		ledger.ID, ledger.BuyerUserID, ledger.Type, ledger.AmountMicros, ledger.BalanceAfterMicros, ledger.RequestID, ledger.Note, ledger.CreatedAt,
	); err != nil {
		return CreditLedgerEntry{}, CreditWallet{}, err
	}
	if err := tx.Commit(); err != nil {
		return CreditLedgerEntry{}, CreditWallet{}, err
	}
	return ledger, CreditWallet{BuyerUserID: userID, BalanceMicros: nextBalance, CreatedAt: now, UpdatedAt: now}, nil
}

func (s *Store) RefundBuyerCreditsForRequest(ctx context.Context, userID, requestID, note string) (CreditLedgerEntry, CreditWallet, error) {
	requestID = strings.TrimSpace(requestID)
	if strings.TrimSpace(userID) == "" || requestID == "" {
		return CreditLedgerEntry{}, CreditWallet{}, ErrInvalid
	}
	now := time.Now().UTC()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return CreditLedgerEntry{}, CreditWallet{}, err
	}
	defer rollback(tx)

	existingRefund, err := creditLedgerByRequestTypeTx(ctx, tx, userID, requestID, "refund")
	if err == nil {
		wallet, walletErr := buyerWalletTx(ctx, tx, userID)
		if walletErr != nil {
			return CreditLedgerEntry{}, CreditWallet{}, walletErr
		}
		if err := tx.Commit(); err != nil {
			return CreditLedgerEntry{}, CreditWallet{}, err
		}
		return existingRefund, wallet, nil
	}
	if err != nil && !errors.Is(err, ErrNotFound) {
		return CreditLedgerEntry{}, CreditWallet{}, err
	}
	debit, err := creditLedgerByRequestTypeTx(ctx, tx, userID, requestID, "debit")
	if err != nil {
		return CreditLedgerEntry{}, CreditWallet{}, err
	}
	refundAmount := -debit.AmountMicros
	if refundAmount <= 0 {
		return CreditLedgerEntry{}, CreditWallet{}, ErrInvalid
	}
	balance, err := buyerWalletBalanceForUpdate(ctx, tx, userID)
	if err != nil {
		return CreditLedgerEntry{}, CreditWallet{}, err
	}
	nextBalance := balance + refundAmount
	ledger := CreditLedgerEntry{
		ID:                 newID("cle"),
		BuyerUserID:        userID,
		Type:               "refund",
		AmountMicros:       refundAmount,
		BalanceAfterMicros: nextBalance,
		RequestID:          requestID,
		Note:               strings.TrimSpace(note),
		CreatedAt:          now,
	}
	if ledger.Note == "" {
		ledger.Note = "request failed"
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE credit_wallets
SET balance_micros = ?, updated_at = ?
WHERE buyer_user_id = ?`, nextBalance, now, userID); err != nil {
		return CreditLedgerEntry{}, CreditWallet{}, err
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO credit_ledger_entries (id, buyer_user_id, type, amount_micros, balance_after_micros, request_id, note, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		ledger.ID, ledger.BuyerUserID, ledger.Type, ledger.AmountMicros, ledger.BalanceAfterMicros, ledger.RequestID, ledger.Note, ledger.CreatedAt,
	); err != nil {
		return CreditLedgerEntry{}, CreditWallet{}, err
	}
	if err := tx.Commit(); err != nil {
		return CreditLedgerEntry{}, CreditWallet{}, err
	}
	return ledger, CreditWallet{BuyerUserID: userID, BalanceMicros: nextBalance, CreatedAt: now, UpdatedAt: now}, nil
}

func (s *Store) RecordRequestUsage(ctx context.Context, input RequestFillInput) (RequestFill, error) {
	if strings.TrimSpace(input.RequestID) == "" || strings.TrimSpace(input.BuyerUserID) == "" {
		return RequestFill{}, ErrInvalid
	}
	now := time.Now().UTC()
	fill := requestFillFromInput(input, now)
	_, err := s.db.ExecContext(ctx, `
INSERT OR IGNORE INTO request_fills (
	request_id, buyer_user_id, buyer_api_key_id, seller_node_id, path, status_code, stream,
	duration_ms, time_to_first_chunk_ms, bytes_out, cost_micros, seller_earning_micros,
	platform_fee_micros, reserve_micros, error, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		fill.RequestID, fill.BuyerUserID, fill.BuyerAPIKeyID, fill.SellerNodeID, fill.Path, fill.StatusCode, fill.Stream,
		fill.DurationMS, fill.TimeToFirstChunkMS, fill.BytesOut, fill.CostMicros, fill.SellerEarningMicros,
		fill.PlatformFeeMicros, fill.ReserveMicros, fill.Error, fill.CreatedAt,
	)
	if err != nil {
		return RequestFill{}, err
	}
	return fill, nil
}

func (s *Store) RecordSuccessfulRequestFillAndSellerEarning(ctx context.Context, input RequestFillInput) (RequestFill, SellerEarningLedgerEntry, error) {
	if strings.TrimSpace(input.RequestID) == "" || strings.TrimSpace(input.BuyerUserID) == "" || strings.TrimSpace(input.SellerNodeID) == "" {
		return RequestFill{}, SellerEarningLedgerEntry{}, ErrInvalid
	}
	if input.StatusCode < 200 || input.StatusCode >= 400 || input.CostMicros <= 0 || input.SellerEarningMicros < 0 {
		return RequestFill{}, SellerEarningLedgerEntry{}, ErrInvalid
	}
	now := time.Now().UTC()
	fill := requestFillFromInput(input, now)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RequestFill{}, SellerEarningLedgerEntry{}, err
	}
	defer rollback(tx)

	exists, err := requestFillExistsTx(ctx, tx, fill.RequestID)
	if err != nil {
		return RequestFill{}, SellerEarningLedgerEntry{}, err
	}
	if exists {
		earning, earningErr := sellerEarningByRequestTx(ctx, tx, fill.RequestID)
		if earningErr != nil && !errors.Is(earningErr, ErrNotFound) {
			return RequestFill{}, SellerEarningLedgerEntry{}, earningErr
		}
		if err := tx.Commit(); err != nil {
			return RequestFill{}, SellerEarningLedgerEntry{}, err
		}
		return fill, earning, nil
	}

	var sellerUserID string
	err = tx.QueryRowContext(ctx, `SELECT seller_user_id FROM seller_nodes WHERE node_id = ?`, fill.SellerNodeID).Scan(&sellerUserID)
	if errors.Is(err, sql.ErrNoRows) {
		return RequestFill{}, SellerEarningLedgerEntry{}, ErrNotFound
	}
	if err != nil {
		return RequestFill{}, SellerEarningLedgerEntry{}, err
	}
	if err := ensureSellerEarningWalletTx(ctx, tx, sellerUserID); err != nil {
		return RequestFill{}, SellerEarningLedgerEntry{}, err
	}

	if _, err := tx.ExecContext(ctx, `
INSERT INTO request_fills (
	request_id, buyer_user_id, buyer_api_key_id, seller_node_id, path, status_code, stream,
	duration_ms, time_to_first_chunk_ms, bytes_out, cost_micros, seller_earning_micros,
	platform_fee_micros, reserve_micros, error, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		fill.RequestID, fill.BuyerUserID, fill.BuyerAPIKeyID, fill.SellerNodeID, fill.Path, fill.StatusCode, fill.Stream,
		fill.DurationMS, fill.TimeToFirstChunkMS, fill.BytesOut, fill.CostMicros, fill.SellerEarningMicros,
		fill.PlatformFeeMicros, fill.ReserveMicros, fill.Error, fill.CreatedAt,
	); err != nil {
		return RequestFill{}, SellerEarningLedgerEntry{}, err
	}

	balance, err := sellerEarningWalletBalanceForUpdate(ctx, tx, sellerUserID)
	if err != nil {
		return RequestFill{}, SellerEarningLedgerEntry{}, err
	}
	nextBalance := balance + fill.SellerEarningMicros
	earning := SellerEarningLedgerEntry{
		ID:                 newID("sel"),
		SellerUserID:       sellerUserID,
		SellerNodeID:       fill.SellerNodeID,
		Type:               "earning",
		AmountMicros:       fill.SellerEarningMicros,
		BalanceAfterMicros: nextBalance,
		RequestID:          fill.RequestID,
		Note:               "successful request fill",
		CreatedAt:          now,
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE seller_earning_wallets
SET balance_micros = ?, updated_at = ?
WHERE seller_user_id = ?`, nextBalance, now, sellerUserID); err != nil {
		return RequestFill{}, SellerEarningLedgerEntry{}, err
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO seller_earning_ledger_entries (
	id, seller_user_id, seller_node_id, type, amount_micros, balance_after_micros, request_id, note, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		earning.ID, earning.SellerUserID, earning.SellerNodeID, earning.Type, earning.AmountMicros, earning.BalanceAfterMicros, earning.RequestID, earning.Note, earning.CreatedAt,
	); err != nil {
		return RequestFill{}, SellerEarningLedgerEntry{}, err
	}
	if err := tx.Commit(); err != nil {
		return RequestFill{}, SellerEarningLedgerEntry{}, err
	}
	return fill, earning, nil
}

func (s *Store) ListBuyerCreditLedger(ctx context.Context, userID string, limit int) ([]CreditLedgerEntry, error) {
	limit = normalizeLimit(limit)
	rows, err := s.db.QueryContext(ctx, `
SELECT id, buyer_user_id, type, amount_micros, balance_after_micros, request_id, note, created_at
FROM credit_ledger_entries
WHERE buyer_user_id = ?
ORDER BY created_at DESC
LIMIT ?`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []CreditLedgerEntry
	for rows.Next() {
		var entry CreditLedgerEntry
		if err := rows.Scan(&entry.ID, &entry.BuyerUserID, &entry.Type, &entry.AmountMicros, &entry.BalanceAfterMicros, &entry.RequestID, &entry.Note, &entry.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, entry)
	}
	return out, rows.Err()
}

func (s *Store) ListBuyerUsage(ctx context.Context, userID string, limit int) ([]RequestFill, error) {
	limit = normalizeLimit(limit)
	rows, err := s.db.QueryContext(ctx, `
SELECT request_id, buyer_user_id, buyer_api_key_id, seller_node_id, path, status_code, stream,
	duration_ms, time_to_first_chunk_ms, bytes_out, cost_micros, seller_earning_micros,
	platform_fee_micros, reserve_micros, error, created_at
FROM request_fills
WHERE buyer_user_id = ?
ORDER BY created_at DESC
LIMIT ?`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanRequestFills(rows)
}

func (s *Store) GetSellerEarningsSummary(ctx context.Context, userID string) (SellerEarningsSummary, error) {
	if err := s.ensureSellerEarningWallet(ctx, userID); err != nil {
		return SellerEarningsSummary{}, err
	}
	var summary SellerEarningsSummary
	summary.SellerUserID = userID
	err := s.db.QueryRowContext(ctx, `SELECT balance_micros FROM seller_earning_wallets WHERE seller_user_id = ?`, userID).Scan(&summary.BalanceMicros)
	if errors.Is(err, sql.ErrNoRows) {
		return SellerEarningsSummary{}, ErrNotFound
	}
	if err != nil {
		return SellerEarningsSummary{}, err
	}
	if err := s.db.QueryRowContext(ctx, `
SELECT COALESCE(SUM(CASE WHEN amount_micros > 0 THEN amount_micros ELSE 0 END), 0),
	COALESCE(SUM(CASE WHEN amount_micros < 0 THEN -amount_micros ELSE 0 END), 0)
FROM seller_earning_ledger_entries
WHERE seller_user_id = ?`, userID).Scan(&summary.TotalEarnedMicros, &summary.TotalPaidOutMicros); err != nil {
		return SellerEarningsSummary{}, err
	}
	summary.AvailablePayoutMicros = summary.BalanceMicros
	return summary, nil
}

func (s *Store) ListSellerEarningLedger(ctx context.Context, userID string, limit int) ([]SellerEarningLedgerEntry, error) {
	limit = normalizeLimit(limit)
	rows, err := s.db.QueryContext(ctx, `
SELECT id, seller_user_id, seller_node_id, type, amount_micros, balance_after_micros, request_id, note, created_at
FROM seller_earning_ledger_entries
WHERE seller_user_id = ?
ORDER BY created_at DESC
LIMIT ?`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []SellerEarningLedgerEntry
	for rows.Next() {
		var entry SellerEarningLedgerEntry
		if err := rows.Scan(&entry.ID, &entry.SellerUserID, &entry.SellerNodeID, &entry.Type, &entry.AmountMicros, &entry.BalanceAfterMicros, &entry.RequestID, &entry.Note, &entry.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, entry)
	}
	return out, rows.Err()
}

func (s *Store) ListSellerActivity(ctx context.Context, userID string, limit int) ([]RequestFill, error) {
	limit = normalizeLimit(limit)
	rows, err := s.db.QueryContext(ctx, `
SELECT rf.request_id, rf.buyer_user_id, rf.buyer_api_key_id, rf.seller_node_id, rf.path, rf.status_code, rf.stream,
	rf.duration_ms, rf.time_to_first_chunk_ms, rf.bytes_out, rf.cost_micros, rf.seller_earning_micros,
	rf.platform_fee_micros, rf.reserve_micros, rf.error, rf.created_at
FROM request_fills rf
JOIN seller_nodes sn ON sn.node_id = rf.seller_node_id
WHERE sn.seller_user_id = ?
ORDER BY rf.created_at DESC
LIMIT ?`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanRequestFills(rows)
}

func (s *Store) CreateSellerNode(ctx context.Context, userID, nodeID, provider string, maxConcurrency int) (SellerNode, error) {
	nodeID = strings.TrimSpace(nodeID)
	if nodeID == "" {
		nodeID = "seller-" + randomHex(4)
	}
	provider = strings.TrimSpace(provider)
	if provider == "" {
		provider = "codex-app-server"
	}
	if maxConcurrency <= 0 {
		maxConcurrency = 1
	}
	now := time.Now().UTC()
	node := SellerNode{
		ID:             newID("node"),
		SellerUserID:   userID,
		NodeID:         nodeID,
		Status:         "created",
		Provider:       provider,
		MaxConcurrency: maxConcurrency,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO seller_nodes (id, seller_user_id, node_id, status, provider, max_concurrency, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		node.ID, node.SellerUserID, node.NodeID, node.Status, node.Provider, node.MaxConcurrency, node.CreatedAt, node.UpdatedAt,
	)
	if err != nil {
		if isUniqueErr(err) {
			return SellerNode{}, ErrConflict
		}
		return SellerNode{}, err
	}
	return node, nil
}

func (s *Store) ListSellerNodes(ctx context.Context, userID string) ([]SellerNode, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, seller_user_id, node_id, status, provider, max_concurrency, last_seen_at, created_at, updated_at
FROM seller_nodes
WHERE seller_user_id = ?
ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []SellerNode
	for rows.Next() {
		var node SellerNode
		if err := rows.Scan(&node.ID, &node.SellerUserID, &node.NodeID, &node.Status, &node.Provider, &node.MaxConcurrency, &node.LastSeenAt, &node.CreatedAt, &node.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, node)
	}
	return out, rows.Err()
}

func (s *Store) CreateSellerSetupToken(ctx context.Context, userID, nodeID string, ttl time.Duration) (SellerSetupToken, error) {
	if ttl <= 0 {
		ttl = 30 * time.Minute
	}
	var internalNodeID string
	err := s.db.QueryRowContext(ctx, `SELECT id FROM seller_nodes WHERE seller_user_id = ? AND node_id = ?`, userID, nodeID).Scan(&internalNodeID)
	if errors.Is(err, sql.ErrNoRows) {
		return SellerSetupToken{}, ErrNotFound
	}
	if err != nil {
		return SellerSetupToken{}, err
	}
	secret := newSecret("subi_setup")
	now := time.Now().UTC()
	setup := SellerSetupToken{Token: secret, ExpiresAt: now.Add(ttl)}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO seller_setup_tokens (id, seller_node_id, setup_token_hash, expires_at, created_at)
VALUES (?, ?, ?, ?, ?)`,
		newID("setup"), internalNodeID, HashSecret(secret), setup.ExpiresAt, now,
	)
	if err != nil {
		return SellerSetupToken{}, err
	}
	return setup, nil
}

func (s *Store) RedeemSellerSetupToken(ctx context.Context, setupSecret string) (SellerSetupConfig, error) {
	if strings.TrimSpace(setupSecret) == "" {
		return SellerSetupConfig{}, ErrUnauthorized
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SellerSetupConfig{}, err
	}
	defer rollback(tx)

	now := time.Now().UTC()
	var setupID, nodeID, provider string
	var maxConcurrency int
	err = tx.QueryRowContext(ctx, `
SELECT st.id, sn.node_id, sn.provider, sn.max_concurrency
FROM seller_setup_tokens st
JOIN seller_nodes sn ON sn.id = st.seller_node_id
WHERE st.setup_token_hash = ? AND st.used_at IS NULL AND st.expires_at > ?`,
		HashSecret(setupSecret), now,
	).Scan(&setupID, &nodeID, &provider, &maxConcurrency)
	if errors.Is(err, sql.ErrNoRows) {
		return SellerSetupConfig{}, ErrUnauthorized
	}
	if err != nil {
		return SellerSetupConfig{}, err
	}

	nodeToken := newSecret("seller_node")
	_, err = tx.ExecContext(ctx, `
UPDATE seller_nodes
SET node_token_hash = ?, status = 'provisioned', updated_at = ?
WHERE node_id = ?`,
		HashSecret(nodeToken), now, nodeID,
	)
	if err != nil {
		return SellerSetupConfig{}, err
	}
	_, err = tx.ExecContext(ctx, `UPDATE seller_setup_tokens SET used_at = ? WHERE id = ?`, now, setupID)
	if err != nil {
		return SellerSetupConfig{}, err
	}
	if err := tx.Commit(); err != nil {
		return SellerSetupConfig{}, err
	}
	return SellerSetupConfig{
		NodeID:         nodeID,
		NodeToken:      nodeToken,
		MaxConcurrency: maxConcurrency,
		Provider:       provider,
	}, nil
}

func (s *Store) AuthenticateSellerNode(ctx context.Context, nodeID, nodeToken string) (SellerNode, error) {
	var node SellerNode
	err := s.db.QueryRowContext(ctx, `
SELECT id, seller_user_id, node_id, status, provider, max_concurrency, last_seen_at, created_at, updated_at
FROM seller_nodes
WHERE node_id = ? AND node_token_hash = ?`,
		strings.TrimSpace(nodeID), HashSecret(nodeToken),
	).Scan(&node.ID, &node.SellerUserID, &node.NodeID, &node.Status, &node.Provider, &node.MaxConcurrency, &node.LastSeenAt, &node.CreatedAt, &node.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return SellerNode{}, ErrUnauthorized
	}
	if err != nil {
		return SellerNode{}, err
	}
	_ = s.MarkSellerNodeOnline(ctx, node.NodeID)
	node.Status = "online"
	now := time.Now().UTC()
	node.LastSeenAt = &now
	node.UpdatedAt = now
	return node, nil
}

func (s *Store) MarkSellerNodeOnline(ctx context.Context, nodeID string) error {
	now := time.Now().UTC()
	_, err := s.db.ExecContext(ctx, `
UPDATE seller_nodes
SET status = 'online', last_seen_at = ?, updated_at = ?
WHERE node_id = ?`, now, now, strings.TrimSpace(nodeID))
	return err
}

func (s *Store) MarkSellerNodeHeartbeat(ctx context.Context, nodeID string) error {
	now := time.Now().UTC()
	_, err := s.db.ExecContext(ctx, `
UPDATE seller_nodes
SET last_seen_at = ?, updated_at = ?
WHERE node_id = ?`, now, now, strings.TrimSpace(nodeID))
	return err
}

func (s *Store) MarkSellerNodeOffline(ctx context.Context, nodeID string) error {
	now := time.Now().UTC()
	_, err := s.db.ExecContext(ctx, `
UPDATE seller_nodes
SET status = 'offline', updated_at = ?
WHERE node_id = ?`, now, strings.TrimSpace(nodeID))
	return err
}

func (s *Store) ensureBuyerWallet(ctx context.Context, userID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if err := ensureBuyerWalletTx(ctx, tx, userID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) ensureSellerEarningWallet(ctx context.Context, userID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if err := ensureSellerEarningWalletTx(ctx, tx, userID); err != nil {
		return err
	}
	return tx.Commit()
}

func ensureBuyerWalletTx(ctx context.Context, tx *sql.Tx, userID string) error {
	if strings.TrimSpace(userID) == "" {
		return ErrInvalid
	}
	now := time.Now().UTC()
	_, err := tx.ExecContext(ctx, `
INSERT OR IGNORE INTO credit_wallets (buyer_user_id, balance_micros, created_at, updated_at)
VALUES (?, 0, ?, ?)`, userID, now, now)
	return err
}

func ensureSellerEarningWalletTx(ctx context.Context, tx *sql.Tx, userID string) error {
	if strings.TrimSpace(userID) == "" {
		return ErrInvalid
	}
	now := time.Now().UTC()
	_, err := tx.ExecContext(ctx, `
INSERT OR IGNORE INTO seller_earning_wallets (seller_user_id, balance_micros, created_at, updated_at)
VALUES (?, 0, ?, ?)`, userID, now, now)
	return err
}

func buyerWalletBalanceForUpdate(ctx context.Context, tx *sql.Tx, userID string) (int64, error) {
	var balance int64
	err := tx.QueryRowContext(ctx, `SELECT balance_micros FROM credit_wallets WHERE buyer_user_id = ?`, userID).Scan(&balance)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return balance, err
}

func sellerEarningWalletBalanceForUpdate(ctx context.Context, tx *sql.Tx, userID string) (int64, error) {
	var balance int64
	err := tx.QueryRowContext(ctx, `SELECT balance_micros FROM seller_earning_wallets WHERE seller_user_id = ?`, userID).Scan(&balance)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return balance, err
}

func buyerWalletTx(ctx context.Context, tx *sql.Tx, userID string) (CreditWallet, error) {
	var wallet CreditWallet
	err := tx.QueryRowContext(ctx, `
SELECT buyer_user_id, balance_micros, created_at, updated_at
FROM credit_wallets
WHERE buyer_user_id = ?`, userID).Scan(&wallet.BuyerUserID, &wallet.BalanceMicros, &wallet.CreatedAt, &wallet.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return CreditWallet{}, ErrNotFound
	}
	if err != nil {
		return CreditWallet{}, err
	}
	return wallet, nil
}

func creditLedgerByRequestTypeTx(ctx context.Context, tx *sql.Tx, userID, requestID, entryType string) (CreditLedgerEntry, error) {
	var entry CreditLedgerEntry
	err := tx.QueryRowContext(ctx, `
SELECT id, buyer_user_id, type, amount_micros, balance_after_micros, request_id, note, created_at
FROM credit_ledger_entries
WHERE buyer_user_id = ? AND request_id = ? AND type = ?`,
		userID, requestID, entryType,
	).Scan(&entry.ID, &entry.BuyerUserID, &entry.Type, &entry.AmountMicros, &entry.BalanceAfterMicros, &entry.RequestID, &entry.Note, &entry.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return CreditLedgerEntry{}, ErrNotFound
	}
	if err != nil {
		return CreditLedgerEntry{}, err
	}
	return entry, nil
}

func requestFillExistsTx(ctx context.Context, tx *sql.Tx, requestID string) (bool, error) {
	var existing string
	err := tx.QueryRowContext(ctx, `SELECT request_id FROM request_fills WHERE request_id = ?`, requestID).Scan(&existing)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func sellerEarningByRequestTx(ctx context.Context, tx *sql.Tx, requestID string) (SellerEarningLedgerEntry, error) {
	var entry SellerEarningLedgerEntry
	err := tx.QueryRowContext(ctx, `
SELECT id, seller_user_id, seller_node_id, type, amount_micros, balance_after_micros, request_id, note, created_at
FROM seller_earning_ledger_entries
WHERE request_id = ? AND type = 'earning'`, requestID).Scan(&entry.ID, &entry.SellerUserID, &entry.SellerNodeID, &entry.Type, &entry.AmountMicros, &entry.BalanceAfterMicros, &entry.RequestID, &entry.Note, &entry.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return SellerEarningLedgerEntry{}, ErrNotFound
	}
	if err != nil {
		return SellerEarningLedgerEntry{}, err
	}
	return entry, nil
}

func requestFillFromInput(input RequestFillInput, createdAt time.Time) RequestFill {
	return RequestFill{
		RequestID:           strings.TrimSpace(input.RequestID),
		BuyerUserID:         strings.TrimSpace(input.BuyerUserID),
		BuyerAPIKeyID:       strings.TrimSpace(input.BuyerAPIKeyID),
		SellerNodeID:        strings.TrimSpace(input.SellerNodeID),
		Path:                strings.TrimSpace(input.Path),
		StatusCode:          input.StatusCode,
		Stream:              input.Stream,
		DurationMS:          input.DurationMS,
		TimeToFirstChunkMS:  input.TimeToFirstChunkMS,
		BytesOut:            input.BytesOut,
		CostMicros:          input.CostMicros,
		SellerEarningMicros: input.SellerEarningMicros,
		PlatformFeeMicros:   input.PlatformFeeMicros,
		ReserveMicros:       input.ReserveMicros,
		Error:               strings.TrimSpace(input.Error),
		CreatedAt:           createdAt,
	}
}

func scanRequestFills(rows *sql.Rows) ([]RequestFill, error) {
	var out []RequestFill
	for rows.Next() {
		var fill RequestFill
		if err := rows.Scan(
			&fill.RequestID,
			&fill.BuyerUserID,
			&fill.BuyerAPIKeyID,
			&fill.SellerNodeID,
			&fill.Path,
			&fill.StatusCode,
			&fill.Stream,
			&fill.DurationMS,
			&fill.TimeToFirstChunkMS,
			&fill.BytesOut,
			&fill.CostMicros,
			&fill.SellerEarningMicros,
			&fill.PlatformFeeMicros,
			&fill.ReserveMicros,
			&fill.Error,
			&fill.CreatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, fill)
	}
	return out, rows.Err()
}

func normalizeLimit(limit int) int {
	if limit <= 0 {
		return 50
	}
	if limit > 200 {
		return 200
	}
	return limit
}

func (s *Store) migrate(ctx context.Context) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			email TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at TIMESTAMP NOT NULL,
			updated_at TIMESTAMP NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS buyer_profiles (
			user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
			created_at TIMESTAMP NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS seller_profiles (
			user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
			created_at TIMESTAMP NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS credit_wallets (
			buyer_user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
			balance_micros INTEGER NOT NULL DEFAULT 0,
			created_at TIMESTAMP NOT NULL,
			updated_at TIMESTAMP NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS seller_earning_wallets (
			seller_user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
			balance_micros INTEGER NOT NULL DEFAULT 0,
			created_at TIMESTAMP NOT NULL,
			updated_at TIMESTAMP NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS web_sessions (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			session_token_hash TEXT NOT NULL UNIQUE,
			expires_at TIMESTAMP NOT NULL,
			created_at TIMESTAMP NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_web_sessions_user ON web_sessions(user_id)`,
		`CREATE TABLE IF NOT EXISTS buyer_api_keys (
			id TEXT PRIMARY KEY,
			buyer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			key_hash TEXT NOT NULL UNIQUE,
			key_prefix TEXT NOT NULL,
			created_at TIMESTAMP NOT NULL,
			last_used_at TIMESTAMP,
			revoked_at TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_buyer_api_keys_user ON buyer_api_keys(buyer_user_id)`,
		`CREATE TABLE IF NOT EXISTS credit_orders (
			id TEXT PRIMARY KEY,
			buyer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			amount_micros INTEGER NOT NULL,
			status TEXT NOT NULL,
			created_at TIMESTAMP NOT NULL,
			paid_at TIMESTAMP
		)`,
		`CREATE INDEX IF NOT EXISTS idx_credit_orders_user ON credit_orders(buyer_user_id, created_at)`,
		`CREATE TABLE IF NOT EXISTS credit_ledger_entries (
			id TEXT PRIMARY KEY,
			buyer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			type TEXT NOT NULL,
			amount_micros INTEGER NOT NULL,
			balance_after_micros INTEGER NOT NULL,
			request_id TEXT NOT NULL DEFAULT '',
			note TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMP NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_credit_ledger_user ON credit_ledger_entries(buyer_user_id, created_at)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_debit_request ON credit_ledger_entries(request_id) WHERE type = 'debit' AND request_id <> ''`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_refund_request ON credit_ledger_entries(request_id) WHERE type = 'refund' AND request_id <> ''`,
		`CREATE TABLE IF NOT EXISTS seller_nodes (
			id TEXT PRIMARY KEY,
			seller_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			node_id TEXT NOT NULL UNIQUE,
			node_token_hash TEXT,
			status TEXT NOT NULL,
			provider TEXT NOT NULL,
			max_concurrency INTEGER NOT NULL,
			last_seen_at TIMESTAMP,
			created_at TIMESTAMP NOT NULL,
			updated_at TIMESTAMP NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_seller_nodes_user ON seller_nodes(seller_user_id)`,
		`CREATE TABLE IF NOT EXISTS seller_setup_tokens (
			id TEXT PRIMARY KEY,
			seller_node_id TEXT NOT NULL REFERENCES seller_nodes(id) ON DELETE CASCADE,
			setup_token_hash TEXT NOT NULL UNIQUE,
			expires_at TIMESTAMP NOT NULL,
			used_at TIMESTAMP,
			created_at TIMESTAMP NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS request_fills (
			request_id TEXT PRIMARY KEY,
			buyer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			buyer_api_key_id TEXT NOT NULL DEFAULT '',
			seller_node_id TEXT NOT NULL DEFAULT '',
			path TEXT NOT NULL DEFAULT '',
			status_code INTEGER NOT NULL,
			stream INTEGER NOT NULL DEFAULT 0,
			duration_ms INTEGER NOT NULL DEFAULT 0,
			time_to_first_chunk_ms INTEGER NOT NULL DEFAULT -1,
			bytes_out INTEGER NOT NULL DEFAULT 0,
			cost_micros INTEGER NOT NULL DEFAULT 0,
			seller_earning_micros INTEGER NOT NULL DEFAULT 0,
			platform_fee_micros INTEGER NOT NULL DEFAULT 0,
			reserve_micros INTEGER NOT NULL DEFAULT 0,
			error TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMP NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_request_fills_buyer ON request_fills(buyer_user_id, created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_request_fills_seller_node ON request_fills(seller_node_id, created_at)`,
		`CREATE TABLE IF NOT EXISTS seller_earning_ledger_entries (
			id TEXT PRIMARY KEY,
			seller_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			seller_node_id TEXT NOT NULL DEFAULT '',
			type TEXT NOT NULL,
			amount_micros INTEGER NOT NULL,
			balance_after_micros INTEGER NOT NULL,
			request_id TEXT NOT NULL DEFAULT '',
			note TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMP NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_seller_earning_ledger_user ON seller_earning_ledger_entries(seller_user_id, created_at)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_seller_earning_request ON seller_earning_ledger_entries(request_id) WHERE type = 'earning' AND request_id <> ''`,
		`INSERT OR IGNORE INTO credit_wallets (buyer_user_id, balance_micros, created_at, updated_at)
		 SELECT id, 0, created_at, updated_at FROM users`,
		`INSERT OR IGNORE INTO seller_earning_wallets (seller_user_id, balance_micros, created_at, updated_at)
		 SELECT id, 0, created_at, updated_at FROM users`,
	}
	for _, stmt := range stmts {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

func HashSecret(secret string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(secret)))
	return hex.EncodeToString(sum[:])
}

func normalizeEmail(value string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(value))
	if email == "" {
		return "", ErrInvalid
	}
	parsed, err := mail.ParseAddress(email)
	if err != nil || strings.ToLower(strings.TrimSpace(parsed.Address)) != email {
		return "", ErrInvalid
	}
	return email, nil
}

func newID(prefix string) string {
	return prefix + "_" + randomHex(12)
}

func newSecret(prefix string) string {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	return prefix + "_" + base64.RawURLEncoding.EncodeToString(raw)
}

func randomHex(size int) string {
	raw := make([]byte, size)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	return hex.EncodeToString(raw)
}

func secretPrefix(secret string) string {
	secret = strings.TrimSpace(secret)
	if len(secret) <= 12 {
		return secret
	}
	return secret[:12]
}

func isUniqueErr(err error) bool {
	return strings.Contains(strings.ToLower(err.Error()), "unique")
}

func requireRows(result sql.Result) error {
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

func rollback(tx *sql.Tx) {
	if tx != nil {
		_ = tx.Rollback()
	}
}
