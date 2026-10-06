// Shared mapping editor. A CLASSIC script (not an ES module): the desktop
// renderer loads over file://, where Chromium blocks module imports.
;(function (global) {
  'use strict'

  function guessRange(ctrlName) {
    const n = String(ctrlName).toLowerCase()
    if (n.includes('gain') || n.includes('level') || n.includes('volume')) return [-100, 10]
    if (n.includes('freq') || n.includes('hz')) return [20, 20000]
    if (n.includes('threshold')) return [-40, 0]
    if (n.includes('ratio')) return [1, 20]
    if (n.includes('attack') || n.includes('release')) return [0, 500]
    if (n.includes('pan')) return [-100, 100]
    if (n.includes('delay') || n.includes('ms')) return [0, 2000]
    return [0, 1]
  }

  // Emits qsys.link only when it names a second target. Fields matching the
  // primary are omitted and inherited back on load. A ticked but unfilled row
  // would otherwise fail server validation and lose the whole save.
  function withLink(a, qsys) {
    if (!a.link) return qsys
    const link = {}
    if (a.link.component && a.link.component !== a.component) link.component = a.link.component
    if (a.link.control && a.link.control !== a.controlName) link.control = a.link.control
    if (link.component || link.control) qsys.link = link
    return qsys
  }

  function buildMappings(physicalControls, assignments) {
    const mappings = []
    for (const pc of physicalControls) {
      const a = assignments.get(pc.id)
      if (!a || !a.component || !a.controlName) continue
      const isToggle = pc.controlType === 'toggle'
      const qsys = isToggle
        ? { type: 'toggle', component: a.component, control: a.controlName }
        : { type: 'component_control', component: a.component, control: a.controlName,
            min: a.min ?? -100, max: a.max ?? 10 }
      mappings.push({ label: a.label || pc.label, midi: { ...pc.midi }, qsys: withLink(a, qsys) })
    }
    return mappings
  }

  // Repointing the primary drops any gang: the old partner is unrelated to
  // the new primary, and silently ganging two unrelated controls is worse
  // than making the user tick Link again.
  function repointPrimary(assignments, id, componentName) {
    const a = assignments.get(id) || {}
    assignments.set(id, { ...a, component: componentName, controlName: '',
                          min: -100, max: 10, link: null })
  }

  global.MappingEditor = {
    __internals: { buildMappings, guessRange, withLink, repointPrimary },
  }
})(typeof window !== 'undefined' ? window : globalThis)
