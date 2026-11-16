// Private (one-to-one) in-meeting chat. Messages are relayed only to the sender and the recipient,
// are never stored, and never reach other participants, the transcript or the recording.
export const PRIVATE_MAX = 1000;
const WINDOW_MS = 5000, WINDOW_MAX = 10;

function summary(peer) { return { peerId: peer.id, username: peer.username }; }

// Validates a private message and returns the payload plus the two peers that may receive it.
export function privateMessage(room, sender, data, now = Date.now()) {
  if (typeof data.to !== 'string' || typeof data.text !== 'string') throw Error('Invalid private message');
  const text = data.text.trim();
  if (!text || text.length > PRIVATE_MAX) throw Error('Invalid private message');
  if (data.to === sender.id) throw Error('You cannot message yourself privately');
  const recipient = [...room.peers].find(p => p.id === data.to);
  if (!recipient) throw Error('That participant is no longer in the meeting');
  if (!sender.chatWindow || now - sender.chatWindow > WINDOW_MS) { sender.chatWindow = now; sender.chatCount = 0; }
  if (++sender.chatCount > WINDOW_MAX) throw Error('Please slow down private messages');
  return { recipient, payload: { from: summary(sender), to: summary(recipient), text, at: new Date(now).toISOString() } };
}
