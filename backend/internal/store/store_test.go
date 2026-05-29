package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestStoreUserBuyerKeyAndSellerSetupFlow(t *testing.T) {
	ctx := context.Background()
	store, err := Open(filepath.Join(t.TempDir(), "subi.db"))
	require.NoError(t, err)
	defer store.Close()

	user, err := store.RegisterUser(ctx, "seller@example.com", "password123")
	require.NoError(t, err)
	require.Equal(t, "seller@example.com", user.Email)

	_, err = store.RegisterUser(ctx, "seller@example.com", "password123")
	require.True(t, errors.Is(err, ErrConflict))

	authenticated, err := store.AuthenticateUser(ctx, "seller@example.com", "password123")
	require.NoError(t, err)
	require.Equal(t, user.ID, authenticated.ID)

	session, expiresAt, err := store.CreateWebSession(ctx, user.ID, time.Hour)
	require.NoError(t, err)
	require.True(t, expiresAt.After(time.Now()))
	sessionUser, err := store.UserBySession(ctx, session)
	require.NoError(t, err)
	require.Equal(t, user.ID, sessionUser.ID)

	apiKey, err := store.CreateBuyerAPIKey(ctx, user.ID, "Codex")
	require.NoError(t, err)
	require.NotEmpty(t, apiKey.Secret)
	keyAuth, err := store.AuthenticateBuyerAPIKey(ctx, apiKey.Secret)
	require.NoError(t, err)
	require.Equal(t, user.ID, keyAuth.UserID)

	node, err := store.CreateSellerNode(ctx, user.ID, "seller-macbook-001", "codex-app-server", 1)
	require.NoError(t, err)
	require.Equal(t, "seller-macbook-001", node.NodeID)

	setup, err := store.CreateSellerSetupToken(ctx, user.ID, node.NodeID, time.Hour)
	require.NoError(t, err)
	require.NotEmpty(t, setup.Token)

	config, err := store.RedeemSellerSetupToken(ctx, setup.Token)
	require.NoError(t, err)
	require.Equal(t, node.NodeID, config.NodeID)
	require.NotEmpty(t, config.NodeToken)

	_, err = store.RedeemSellerSetupToken(ctx, setup.Token)
	require.True(t, errors.Is(err, ErrUnauthorized))

	sellerNode, err := store.AuthenticateSellerNode(ctx, config.NodeID, config.NodeToken)
	require.NoError(t, err)
	require.Equal(t, "online", sellerNode.Status)

	nodes, err := store.ListSellerNodes(ctx, user.ID)
	require.NoError(t, err)
	require.Len(t, nodes, 1)
	require.Equal(t, "online", nodes[0].Status)
}
