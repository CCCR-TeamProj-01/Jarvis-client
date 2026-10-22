import type { Unsubscribe } from '../../shared/contracts/common'
import type { AuthManager } from './auth-manager'

/**
 * Runs a per-user service while someone is signed in. Signing out, or the session ending, stops it
 * and cancels what is running; another account signing in starts it for that account.
 */
export function runWhileSignedIn(
  auth: Pick<AuthManager, 'getSnapshot' | 'subscribe'>,
  service: { start(userId: string): void; stop(): Promise<void> }
): Unsubscribe {
  const apply = (snapshot: ReturnType<AuthManager['getSnapshot']>) => {
    if (snapshot.phase === 'signed_in') service.start(snapshot.user.userId)
    else void service.stop()
  }
  apply(auth.getSnapshot())
  const unsubscribe = auth.subscribe((event) => {
    if (event.type === 'auth.state_changed') apply(event.snapshot)
  })
  return () => {
    unsubscribe()
    void service.stop()
  }
}
