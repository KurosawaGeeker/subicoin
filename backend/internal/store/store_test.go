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

func TestStoreCreditLedgerAndSellerEarningsFlow(t *testing.T) {
	ctx := context.Background()
	store, err := Open(filepath.Join(t.TempDir(), "subi.db"))
	require.NoError(t, err)
	defer store.Close()

	buyer, err := store.RegisterUser(ctx, "buyer@example.com", "password123")
	require.NoError(t, err)
	seller, err := store.RegisterUser(ctx, "seller@example.com", "password123")
	require.NoError(t, err)
	apiKey, err := store.CreateBuyerAPIKey(ctx, buyer.ID, "Codex")
	require.NoError(t, err)
	node, err := store.CreateSellerNode(ctx, seller.ID, "seller-001", "codex-app-server", 1)
	require.NoError(t, err)

	wallet, err := store.GetBuyerCreditWallet(ctx, buyer.ID)
	require.NoError(t, err)
	require.EqualValues(t, 0, wallet.BalanceMicros)

	_, _, err = store.ReserveBuyerCreditsForRequest(ctx, buyer.ID, "req-empty", CreditMicrosPerCredit, "test")
	require.True(t, errors.Is(err, ErrInsufficientCredits))

	order, recharge, wallet, err := store.CreateMockCreditOrder(ctx, buyer.ID, 100*CreditMicrosPerCredit)
	require.NoError(t, err)
	require.Equal(t, "paid", order.Status)
	require.Equal(t, "recharge", recharge.Type)
	require.EqualValues(t, 100*CreditMicrosPerCredit, wallet.BalanceMicros)

	debit, wallet, err := store.ReserveBuyerCreditsForRequest(ctx, buyer.ID, "req-refund", CreditMicrosPerCredit, "test reserve")
	require.NoError(t, err)
	require.Equal(t, "debit", debit.Type)
	require.EqualValues(t, -CreditMicrosPerCredit, debit.AmountMicros)
	require.EqualValues(t, 99*CreditMicrosPerCredit, wallet.BalanceMicros)

	refund, wallet, err := store.RefundBuyerCreditsForRequest(ctx, buyer.ID, "req-refund", "failed")
	require.NoError(t, err)
	require.Equal(t, "refund", refund.Type)
	require.EqualValues(t, CreditMicrosPerCredit, refund.AmountMicros)
	require.EqualValues(t, 100*CreditMicrosPerCredit, wallet.BalanceMicros)

	_, _, err = store.ReserveBuyerCreditsForRequest(ctx, buyer.ID, "req-success", CreditMicrosPerCredit, "test reserve")
	require.NoError(t, err)
	fill, earning, err := store.RecordSuccessfulRequestFillAndSellerEarning(ctx, RequestFillInput{
		RequestID:           "req-success",
		BuyerUserID:         buyer.ID,
		BuyerAPIKeyID:       apiKey.ID,
		SellerNodeID:        node.NodeID,
		Path:                "/v1/responses",
		StatusCode:          200,
		DurationMS:          123,
		TimeToFirstChunkMS:  12,
		BytesOut:            456,
		CostMicros:          CreditMicrosPerCredit,
		SellerEarningMicros: 800_000,
		PlatformFeeMicros:   150_000,
		ReserveMicros:       50_000,
	})
	require.NoError(t, err)
	require.Equal(t, "req-success", fill.RequestID)
	require.EqualValues(t, 800_000, earning.AmountMicros)

	wallet, err = store.GetBuyerCreditWallet(ctx, buyer.ID)
	require.NoError(t, err)
	require.EqualValues(t, 99*CreditMicrosPerCredit, wallet.BalanceMicros)

	ledger, err := store.ListBuyerCreditLedger(ctx, buyer.ID, 10)
	require.NoError(t, err)
	require.Len(t, ledger, 4)

	usage, err := store.ListBuyerUsage(ctx, buyer.ID, 10)
	require.NoError(t, err)
	require.Len(t, usage, 1)
	require.Equal(t, "seller-001", usage[0].SellerNodeID)

	summary, err := store.GetSellerEarningsSummary(ctx, seller.ID)
	require.NoError(t, err)
	require.EqualValues(t, 800_000, summary.BalanceMicros)
	require.EqualValues(t, 800_000, summary.TotalEarnedMicros)

	activity, err := store.ListSellerActivity(ctx, seller.ID, 10)
	require.NoError(t, err)
	require.Len(t, activity, 1)
	require.Equal(t, "req-success", activity[0].RequestID)
}
