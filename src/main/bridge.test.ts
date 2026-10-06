import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bridge } from './bridge.js'
import type { Config } from './config.js'

/** Reaches the MIDI port the bridge wires its handlers to. */
type Wired = { midi: { listenerCount(event: string): number } }

function config(): Config {
  return {
    qsys: { host: '', port: 1710 },
    midi: { deviceName: 'nothing-is-open' },
    mappings: [],
    feedback: { enabled: false, mute_leds: [] },
  }
}

test('the bridge listens for every MIDI event the engine can act on', () => {
  // A handler the bridge forgets to wire is a control that silently does
  // nothing on the desk — pitch bend and note_off are the new two.
  const bridge = new Bridge(config())
  const midi = (bridge as unknown as Wired).midi
  for (const event of ['cc', 'note_on', 'note_off', 'pitchbend']) {
    assert.equal(midi.listenerCount(event), 1, `no handler wired for "${event}"`)
  }
})
