/**
 * Golden fixtures for the mapping editors.
 *
 * Plain data, deliberately NOT inside a *.test.ts file: importing a node:test
 * file to get a value re-registers its tests and runs them twice.
 *
 * `expected` is the frozen output of buildMappings() for one physical control
 * carrying `assignment`. The web page and the desktop Configurator agreed on
 * every fixture when this was frozen. Fixtures without `expected` emit nothing
 * at all.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

export const KNOB_A1 = { id: 'Ka1', label: 'Knob A 1', group: 'Knobs A', controlType: 'knob', midi: { type: 'cc', channel: 4, number: 22 } }
export const MUTE_1 = { id: 'M1', label: 'Mute 1', group: 'Mutes', controlType: 'toggle', midi: { type: 'cc', channel: 1, number: 22 } }
export const BANKL = { id: 'BANKL', label: 'Bank Left', group: 'Buttons', controlType: 'toggle', midi: { type: 'note_on', channel: 1, number: 25 } }

export interface GoldenFixture {
  name: string
  pc: Any
  assignment: Any
  expected?: Any
}

export const GOLDEN_FIXTURES: GoldenFixture[] = [
  { name: 'plain knob', pc: KNOB_A1,
    assignment: { component: 'Mic.02.Gain', controlName: 'gain', min: -100, max: 20 },
    expected: { label: 'Knob A 1', midi: { type: 'cc', channel: 4, number: 22 },
                qsys: { type: 'component_control', component: 'Mic.02.Gain', control: 'gain', min: -100, max: 20 } } },
  { name: 'plain toggle', pc: MUTE_1,
    assignment: { component: 'Mic.02.Gain', controlName: 'mute' },
    expected: { label: 'Mute 1', midi: { type: 'cc', channel: 1, number: 22 },
                qsys: { type: 'toggle', component: 'Mic.02.Gain', control: 'mute' } } },
  { name: 'ganged knob, component-only link', pc: KNOB_A1,
    assignment: { component: 'Dante.In.9.Gain', controlName: 'gain', min: -100, max: 20,
                  link: { component: 'Dante.In.10.Gain', control: 'gain' } },
    expected: { label: 'Knob A 1', midi: { type: 'cc', channel: 4, number: 22 },
                qsys: { type: 'component_control', component: 'Dante.In.9.Gain', control: 'gain', min: -100, max: 20,
                        link: { component: 'Dante.In.10.Gain' } } } },
  { name: 'ganged knob, control-only link', pc: KNOB_A1,
    assignment: { component: 'Dante.Pair.Gain', controlName: 'gain.1', min: -100, max: 20,
                  link: { component: 'Dante.Pair.Gain', control: 'gain.2' } },
    expected: { label: 'Knob A 1', midi: { type: 'cc', channel: 4, number: 22 },
                qsys: { type: 'component_control', component: 'Dante.Pair.Gain', control: 'gain.1', min: -100, max: 20,
                        link: { control: 'gain.2' } } } },
  { name: 'ganged knob, both fields differ', pc: KNOB_A1,
    assignment: { component: 'A.Gain', controlName: 'gain.1', min: -100, max: 20,
                  link: { component: 'B.Gain', control: 'gain.2' } },
    expected: { label: 'Knob A 1', midi: { type: 'cc', channel: 4, number: 22 },
                qsys: { type: 'component_control', component: 'A.Gain', control: 'gain.1', min: -100, max: 20,
                        link: { component: 'B.Gain', control: 'gain.2' } } } },
  { name: 'ganged toggle', pc: MUTE_1,
    assignment: { component: 'Dante.In.9.Gain', controlName: 'mute',
                  link: { component: 'Dante.In.10.Gain', control: 'mute' } },
    expected: { label: 'Mute 1', midi: { type: 'cc', channel: 1, number: 22 },
                qsys: { type: 'toggle', component: 'Dante.In.9.Gain', control: 'mute',
                        link: { component: 'Dante.In.10.Gain' } } } },
  // Ticked-but-unfilled link: the mapping is emitted, minus the broken link.
  { name: 'link ticked but unfilled', pc: KNOB_A1,
    assignment: { component: 'Dante.In.9.Gain', controlName: 'gain', min: -100, max: 20,
                  link: { component: '', control: 'gain' } },
    expected: { label: 'Knob A 1', midi: { type: 'cc', channel: 4, number: 22 },
                qsys: { type: 'component_control', component: 'Dante.In.9.Gain', control: 'gain', min: -100, max: 20 } } },
  // No control name: nothing is emitted at all (no `expected`).
  { name: 'no control name', pc: KNOB_A1,
    assignment: { component: 'Mic.02.Gain', controlName: '' } },
  { name: 'custom label', pc: KNOB_A1,
    assignment: { component: 'Mic.02.Gain', controlName: 'gain', min: -18, max: 18, label: 'Mic 2 Trim' },
    expected: { label: 'Mic 2 Trim', midi: { type: 'cc', channel: 4, number: 22 },
                qsys: { type: 'component_control', component: 'Mic.02.Gain', control: 'gain', min: -18, max: 18 } } },
]
