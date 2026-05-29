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
	ErrConflict     = errors.New("subi store: conflict")
	ErrInvalid      = errors.New("subi store: invalid input")
	ErrNotFound     = errors.New("subi store: not found")
	ErrUnauthorized = errors.New("subi store: unauthorized")
)

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
