// Browser preview: when the renderer runs outside Electron, stand in for the preload bridge with
// the sample program, a local paper and a scripted kernel, so the interface can be reviewed in a
// normal browser. Electron never loads this path because window.humanstudy already exists.
import type { AccountStatus, CommunityStudy, CommunityStudyDetail, HumanStudyApi, KernelEvent, ProjectSnapshot, ProjectSummary, ProviderStatus, Settings } from '../preload/types'
import sample from '../shared/sample-program.json'

if (!('humanstudy' in window)) {
  const listeners = new Set<(e: KernelEvent) => void>()
  const emit = (e: KernelEvent) => listeners.forEach((cb) => cb(e))
  const timers = new Map<string, number[]>()
  const snapshot: ProjectSnapshot = {
    dir: '/preview/knobe-2003',
    name: 'Knobe 2003 · browser preview',
    program: sample,
    artifacts: [],
    exports: [],
    pdf: { name: 'paper.pdf', path: '/preview/paper.pdf', url: '/preview/paper.pdf', ext: 'pdf' },
  }
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
  const projects: ProjectSummary[] = [
    { dir: snapshot.dir, name: 'Knobe 2003 · side-effect effect', updatedAt: ago(14), hasPaper: true, hasProgram: true, artifactCount: 2 },
    { dir: '/preview/untitled', name: 'Untitled project', updatedAt: ago(60 * 26), hasPaper: false, hasProgram: false, artifactCount: 0 },
  ]
  const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'
  const settings: Settings = {
    theme: 'system',
    busyEnter: 'queue',
    permission: 'ask',
    model: 'anthropic/claude-haiku-5.5',
    projectsRoot: '~/Documents/HumanStudy Projects',
  }
  const providers: ProviderStatus[] = [
    { id: 'openrouter', label: 'OpenRouter', configured: false },
    { id: 'anthropic', label: 'Anthropic', configured: false },
    { id: 'deepseek', label: 'DeepSeek', configured: false },
  ]
  const account: AccountStatus = {
    signedIn: false,
    unlocked: false,
    server: 'https://humanstudy-hub-web.vercel.app',
    modelAccess: 'none',
  }
  const accountStatus = (): AccountStatus => ({
    ...account,
    modelAccess: providers.some((p) => p.id === 'openrouter' && p.configured)
      ? 'own-key'
      : account.unlocked
        ? 'hosted'
        : 'none',
  })
  const script = (text: string): Omit<KernelEvent, 'sessionId'>[] => [
    { type: 'status', text: 'Reading the project' },
    { type: 'tool', tool: 'read', detail: 'program.json' },
    { type: 'tool', tool: 'read', detail: 'paper.pdf · pages 1–2' },
    ...`This is a browser preview with a scripted agent, so nothing here comes from a model. You asked: “${text.slice(0, 120)}”. In the app, the agent reads the paper and the program, answers with citations, and writes any view or export into the project's artifacts.`
      .split(/(?<= )/)
      .map((w) => ({ type: 'text' as const, text: w })),
    { type: 'done' },
  ]
  // Real titles, authors, years and descriptions copied from HumanStudy-Bench's studies_index.json.
  const communityStudies: CommunityStudy[] = [
    {
      "id": "study_001",
      "title": "The “False Consensus Effect”: An Egocentric Bias in Social Perception and Attribution Processes",
      "authors": [
        "Lee Ross",
        "David Greene",
        "Pamela House"
      ],
      "year": 1977,
      "description": "Evidence from four studies demonstrates that social observers tend to perceive a “false consensus” with respect to the relative commonness of their own responses. A related bias was shown to exist in the observers’ social inferences. Thus, raters estimated particular responses to be relatively common and relatively unrevealing concerning the actors’ distinguishing personal dispositions when the responses in question were similar to the raters’ own responses; responses differing from those of the rater, by contrast, were perceived to be relatively uncommon and revealing of the actor. These results were obtained both in questionnaire studies presenting subjects with hypothetical situations and choices and in authentic conflict situations. The implications of these findings for our understanding of social perception phenomena and for our analysis of the divergent perceptions of actors and observers are discussed. Finally, cognitive and perceptual mechanisms are proposed which might account for distortions in perceived consensus and for corresponding biases in social inference and attributional processes....",
      "contributors": []
    },
    {
      "id": "study_002",
      "title": "Measures of Anchoring in Estimation Tasks",
      "authors": [
        "Karen E. Jacowitz",
        "Daniel Kahneman"
      ],
      "year": 1995,
      "description": "The authors describe a method for the quantitative study of anchoring effects in estimation tasks. A calibration group provides estimates of a set of uncertain quantities. Subjects in the anchored condition first judge whether a specified number (the anchor) is higher or lower than the true value before estimating each quantity. The anchors are set at predetermined percentiles of the distribution of estimates in the calibration group (15th and 85th percentiles in this study). This procedure permits the transformation of anchored estimates into percentiles in the calibration group, allows pooling of results across problems, and provides a natural measure of the size of the effect. The authors illustrate the method by a demonstration that the initial judgment of the anchor is susceptible to an anchoring-like bias and by an analysis of the relation between anchoring and subjective confidence....",
      "contributors": []
    },
    {
      "id": "study_005",
      "title": "Intentional Action and Side-Effects in Ordinary Language",
      "authors": [
        "Joshua Knobe"
      ],
      "year": null,
      "description": "The paper addresses a controversy in the concept of intentional action: whether side-effects of an action are brought about intentionally. The author hypothesizes that people's intuitions are influenced by their attitude toward the specific side-effect. Through two experiments, the author demonstrates an asymmetry: people are considerably more willing to say a side-effect was brought about intentionally when they regard that side-effect as bad (harmful) than when they regard it as good (helpful). This finding suggests that the assignment of praise and blame is at the root of how people apply the concept of intentionality....",
      "contributors": []
    },
    {
      "id": "study_006",
      "title": "FORMING IMPRESSIONS OF PERSONALITY",
      "authors": [
        "S. E. ASCH"
      ],
      "year": 1946,
      "description": "This classic study investigates the processes by which unified impressions of personality are formed. The author challenges the view that impressions are formed by the simple summation of independent traits. Through a series of experiments, Asch demonstrates that certain 'central' traits (such as 'warm' and 'cold') have a disproportionate effect on the final impression, while other 'peripheral' traits have less impact. The research also explores how the meaning of a trait changes depending on its context and the order in which information is received (the primacy effect). The findings suggest that impressions are structured wholes rather than mere collections of discrete characteristics....",
      "contributors": []
    }
  ]
  const communityFiles: Record<string, [string, number][]> = {
    "study_001": [
      [
        "index.json",
        1359
      ],
      [
        "source/4705-Ross-et-al-False-Consensus-Effect.pdf",
        1607159
      ],
      [
        "source/metadata.json",
        3724
      ],
      [
        "source/specification.json",
        1897
      ],
      [
        "source/ground_truth.json",
        13332
      ],
      [
        "source/materials/study_1_hypothetical_stories.json",
        5469
      ],
      [
        "source/materials/study_2_personal_description_items.json",
        7373
      ]
    ],
    "study_002": [
      [
        "index.json",
        1067
      ],
      [
        "source/jacowitz-kahneman-1995-measures-of-anchoring-in-estimation-tasks.pdf",
        1037381
      ],
      [
        "source/metadata.json",
        3934
      ],
      [
        "source/specification.json",
        2551
      ],
      [
        "source/ground_truth.json",
        13176
      ]
    ],
    "study_005": [
      [
        "index.json",
        781
      ],
      [
        "source/KNOBE.pdf",
        23232
      ],
      [
        "source/metadata.json",
        2383
      ],
      [
        "source/specification.json",
        1570
      ],
      [
        "source/ground_truth.json",
        5680
      ],
      [
        "source/materials/experiment_1_harm.json",
        1235
      ],
      [
        "source/materials/experiment_2_help.json",
        1141
      ],
      [
        "source/materials/experiment_2_harm.json",
        1120
      ]
    ],
    "study_006": [
      [
        "index.json",
        824
      ],
      [
        "source/Asch-Forming-Impressions-Of-Personality.pdf",
        2189141
      ],
      [
        "source/metadata.json",
        4881
      ],
      [
        "source/specification.json",
        2541
      ],
      [
        "source/ground_truth.json",
        26114
      ],
      [
        "source/materials/exp_6_order_effect.json",
        1493
      ],
      [
        "source/materials/exp_10_resemblance.json",
        1348
      ]
    ]
  }
  const REPO = 'https://github.com/HumanStudy-Hub/HumanStudy-Bench'
  const communityDetail = (id: string): CommunityStudyDetail => {
    const study = communityStudies.find((s) => s.id === id)
    if (!study) throw new Error(`Unknown study ${id}`)
    const base = `${REPO}/blob/main/studies/${id}`
    return {
      ...study,
      files: (communityFiles[id] ?? []).map(([path, size]) => ({ path, size, url: `${base}/${path}` })),
      // Clearly fake activity: the preview never talks to GitHub.
      activity: [
        { sha: 'preview0000001', message: 'Preview activity · not from GitHub', author: 'preview', date: ago(60 * 3), url: `${REPO}/commits/main/studies/${id}` },
        { sha: 'preview0000002', message: 'Preview activity · materials listing\n\nMock commit body.', author: 'preview', date: ago(60 * 24 * 5), url: `${REPO}/commits/main/studies/${id}` },
      ],
      repoUrl: `${REPO}/tree/main/studies/${id}`,
      discussionsUrl: `${REPO}/discussions`,
    }
  }
  const api: HumanStudyApi = {
    projects: {
      list: async () => projects.map((p) => ({ ...p })),
      create: async ({ name, pdfPath, sample: isSample }) => {
        if (isSample) {
          const existing = projects.find((p) => p.dir === snapshot.dir)
          if (existing) {
            existing.updatedAt = new Date().toISOString()
            return existing.dir
          }
          projects.unshift({ dir: snapshot.dir, name: 'Knobe 2003 · side-effect effect', updatedAt: new Date().toISOString(), hasPaper: true, hasProgram: true, artifactCount: 0 })
          return snapshot.dir
        }
        let dir = `/preview/${slug(name)}`
        for (let i = 2; projects.some((p) => p.dir === dir); i++) dir = `/preview/${slug(name)}-${i}`
        projects.unshift({ dir, name: name || 'Untitled project', updatedAt: new Date().toISOString(), hasPaper: Boolean(pdfPath), hasProgram: false, artifactCount: 0 })
        return dir
      },
      pickPdf: async () => '/preview/paper.pdf',
      rename: async (dir, name) => {
        const p = projects.find((x) => x.dir === dir)
        if (p) {
          p.name = name
          p.updatedAt = new Date().toISOString()
        }
        return dir
      },
      trash: async (dir) => {
        const i = projects.findIndex((p) => p.dir === dir)
        if (i >= 0) projects.splice(i, 1)
      },
    },
    community: {
      studies: async () => {
        await new Promise((r) => setTimeout(r, 350))
        return communityStudies.map((s) => ({ ...s }))
      },
      study: async (id) => {
        await new Promise((r) => setTimeout(r, 250))
        return communityDetail(id)
      },
      fork: async (id) => {
        const study = communityDetail(id)
        const name = `${study.authors[0]?.split(' ').pop() ?? 'Study'}${study.year ? ` ${study.year}` : ''} · ${study.title}`
        let dir = `/preview/${slug(study.id)}`
        for (let i = 2; projects.some((p) => p.dir === dir); i++) dir = `/preview/${slug(study.id)}-${i}`
        projects.unshift({ dir, name, updatedAt: new Date().toISOString(), hasPaper: true, hasProgram: false, artifactCount: 0 })
        return dir
      },
      openExternal: async (url) => {
        window.open(url, '_blank', 'noopener')
      },
    },
    account: {
      status: async () => accountStatus(),
      signIn: async (email, password) => {
        if (!email.trim() || !password) throw new Error('Enter your email and password.')
        Object.assign(account, { signedIn: true, email: email.trim() })
        return accountStatus()
      },
      signUp: async () => ({ needsConfirmation: true }),
      signOut: async () => {
        Object.assign(account, { signedIn: false, email: undefined, unlocked: false, keyExpiresAt: undefined })
        return accountStatus()
      },
      unlock: async (code) => {
        if (!account.signedIn) throw new Error('Sign in first, then enter your code.')
        if (code.trim() !== 'preview') throw new Error('That code is not valid.')
        account.unlocked = true
        account.keyExpiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString()
        return accountStatus()
      },
    },
    settings: {
      get: async () => ({ ...settings }),
      set: async (patch) => ({ ...Object.assign(settings, patch) }),
      providers: async () => providers.map((p) => ({ ...p })),
      setKey: async (id, key) => {
        const p = providers.find((x) => x.id === id)
        if (p) p.configured = key.length > 0
        return providers.map((x) => ({ ...x }))
      },
    },
    project: {
      open: async () => snapshot.dir,
      read: async (dir) => {
        if (dir === snapshot.dir) return snapshot
        const p = projects.find((x) => x.dir === dir)
        return {
          dir,
          name: p?.name ?? 'Untitled project',
          program: null,
          artifacts: [],
          exports: [],
          pdf: p?.hasPaper ? snapshot.pdf : null,
        }
      },
      reveal: async () => undefined,
      onChanged: () => () => undefined,
    },
    kernel: {
      startSession: async () => 'preview-session',
      send: async (sessionId, text) => {
        const ids = script(text).map((e, i) => window.setTimeout(() => emit({ sessionId, ...e }), 120 + i * 45))
        timers.set(sessionId, ids)
      },
      abort: async (sessionId) => {
        timers.get(sessionId)?.forEach((t) => clearTimeout(t))
        emit({ sessionId, type: 'done' })
      },
      onEvent: (cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    },
  }
  ;(window as unknown as { humanstudy: HumanStudyApi }).humanstudy = api
}
