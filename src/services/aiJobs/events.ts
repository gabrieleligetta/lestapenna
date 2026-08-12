import { EventEmitter } from 'events';
import type { AiJobRow } from '../../db/repositories/AiJobRepository';

/**
 * What is happening to the jobs, right now.
 *
 * One in-process emitter, because this product is one container: a job is
 * created, executed and watched inside the same Node process, so a message bus
 * between those three would be plumbing with nothing on the other end.
 *
 * It carries two unrelated conversations, which is why they are named:
 *
 *  - `enqueued` wakes the runner. It exists so the service that accepts a
 *    request does not have to know the runner: without it the two would import
 *    each other, and Nest would need a `forwardRef` to untangle what is really
 *    just "somebody put work on the pile".
 *  - `changed` feeds the browsers. Every state transition is published here and
 *    the SSE endpoint filters by requester, so a person watching a card sees it
 *    turn green at the instant it does, without a single poll.
 *
 * Nothing durable passes through here: the register is the database, and a
 * listener that misses an event catches up on its next read. That is what makes
 * a dropped connection harmless.
 */
class AiJobEvents extends EventEmitter {
    /** Work is waiting. Sent after the row is committed, never before. */
    emitEnqueued(): void {
        this.emit('enqueued');
    }

    /** A job moved. The whole row travels: a listener never has to query back. */
    emitChanged(job: AiJobRow): void {
        this.emit('changed', job);
    }

    onEnqueued(listener: () => void): () => void {
        this.on('enqueued', listener);
        return () => { this.off('enqueued', listener); };
    }

    onChanged(listener: (job: AiJobRow) => void): () => void {
        this.on('changed', listener);
        return () => { this.off('changed', listener); };
    }
}

export const aiJobEvents = new AiJobEvents();

/*
 * One process, many browser tabs: the default cap of 10 listeners is a leak
 * detector, and here a listener per open tab is the design. Raised rather than
 * removed, so a genuine leak still says so.
 */
aiJobEvents.setMaxListeners(200);
