type Send = (message: string) => void

const receiptRooms = new Map<string, Set<Send>>()
const pickupRooms = new Map<string, Set<Send>>()

function subscribe(rooms: Map<string, Set<Send>>, key: string, send: Send): () => void {
  const subscribers = rooms.get(key) ?? new Set<Send>()
  rooms.set(key, subscribers)
  subscribers.add(send)
  return () => {
    subscribers.delete(send)
    if (subscribers.size === 0) rooms.delete(key)
  }
}

function broadcast(rooms: Map<string, Set<Send>>, key: string, message: string) {
  for (const send of rooms.get(key) ?? []) {
    try {
      send(message)
    } catch {
      // The socket has already closed; its onClose handler removes it.
    }
  }
}

export function subscribeReceiptUpdates(receiptToken: string, send: Send): () => void {
  return subscribe(receiptRooms, receiptToken, send)
}

export function subscribePickupUpdates(token: string, send: Send): () => void {
  return subscribe(pickupRooms, token, send)
}

/** Notify the customer view after a ticket or one of its consumptions changes state. */
export function broadcastReceiptUpdate(receiptToken: string) {
  broadcast(receiptRooms, receiptToken, JSON.stringify({ type: "receipt-updated" }))
}

/** Notify the full-screen pickup QR as soon as the bartender completes the delivery. */
export function broadcastPickupUpdate(token: string) {
  broadcast(pickupRooms, token, JSON.stringify({ type: "pickup-updated" }))
}
