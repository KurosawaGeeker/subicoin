package service

import (
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestSubiSellerNodeRegistryStickySession(t *testing.T) {
	registry := NewSubiSellerNodeRegistry()
	registry.registerNode(&subiSellerNode{id: "seller-a", lastSeen: time.Now()})

	reservation, err := registry.reserveNode("session-1", "req-1")
	require.NoError(t, err)
	require.Equal(t, "seller-a", reservation.node.id)
	registry.registerNode(&subiSellerNode{id: "seller-b", lastSeen: time.Now()})

	_, err = registry.reserveNode("session-1", "req-2")
	require.True(t, errors.Is(err, ErrSubiP2PAgentBusy))

	registry.releaseRequest("seller-a", "req-1")

	reservation, err = registry.reserveNode("session-1", "req-3")
	require.NoError(t, err)
	require.Equal(t, "seller-a", reservation.node.id)
}

func TestSubiSellerNodeRegistryStickyStaleFallsBack(t *testing.T) {
	registry := NewSubiSellerNodeRegistry()
	registry.registerNode(&subiSellerNode{id: "seller-a", lastSeen: time.Now().Add(-defaultSubiAgentStaleAfter - time.Second)})
	registry.sticky["session-1"] = "seller-a"
	registry.registerNode(&subiSellerNode{id: "seller-b", lastSeen: time.Now()})

	reservation, err := registry.reserveNode("session-1", "req-1")
	require.NoError(t, err)
	require.Equal(t, "seller-b", reservation.node.id)
	require.Equal(t, "seller-a", reservation.previousNodeID)
	require.Equal(t, "seller-b", registry.sticky["session-1"])
}

func TestSubiSellerNodeRegistryUnregisterClosesPendingRequest(t *testing.T) {
	registry := NewSubiSellerNodeRegistry()
	registry.registerNode(&subiSellerNode{
		id:             "seller-a",
		lastSeen:       time.Now(),
		activeRequests: map[string]struct{}{"req-1": {}},
	})

	state := &subiP2PRequestState{
		ch:   make(chan SubiP2PResponseEvent, 1),
		done: make(chan struct{}),
	}
	registry.requests["req-1"] = state

	registry.unregisterNode("seller-a")

	ev, ok := <-state.ch
	require.True(t, ok)
	require.Equal(t, SubiEnvelopeResponseError, ev.Type)
	require.Equal(t, "seller agent disconnected", ev.Error)
	require.Equal(t, "seller-a", ev.NodeID)

	_, ok = <-state.ch
	require.False(t, ok)
	require.NotContains(t, registry.requests, "req-1")
}

func TestSubiSellerNodeRegistryMaxConcurrency(t *testing.T) {
	registry := NewSubiSellerNodeRegistry()
	registry.registerNode(&subiSellerNode{
		id:             "seller-a",
		maxConcurrency: 2,
		lastSeen:       time.Now(),
	})

	first, err := registry.reserveNode("", "req-1")
	require.NoError(t, err)
	require.Equal(t, "seller-a", first.node.id)

	second, err := registry.reserveNode("", "req-2")
	require.NoError(t, err)
	require.Equal(t, "seller-a", second.node.id)

	_, err = registry.reserveNode("", "req-3")
	require.True(t, errors.Is(err, ErrSubiP2PNoAvailableNode))

	registry.releaseRequest("seller-a", "req-1")

	third, err := registry.reserveNode("", "req-3")
	require.NoError(t, err)
	require.Equal(t, "seller-a", third.node.id)
}
