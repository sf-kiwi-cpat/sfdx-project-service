import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import {
  assignGovernanceOwner,
  createGovernanceAsset,
  createGovernanceTask,
  fetchGovernanceBootstrap,
  type GovernanceAsset,
  type GovernanceBootstrap,
  type GovernanceCurrentUser,
  type GovernanceEventLog,
  type GovernanceTask,
  type GovernanceUser,
  recordGovernanceExport,
  runGovernanceBulkAction,
  runGovernanceFullScan,
  runGovernanceStaleReview
} from './governanceApi'
import { useAgentChat } from './useAgentChat'

type PageKey = 'dashboard' | 'explorer' | 'reports' | 'agent' | 'tasks'
type TaskPriority = 'Low' | 'Medium' | 'High' | 'Critical'
type BulkActionType = 'assign_owner' | 'create_task' | 'mark_healthy'
type AssetStatus = GovernanceAsset['status']

type NavItem = {
  key: PageKey
  label: string
  hint: string
}

type StatCard = {
  label: string
  value: string
  helper: string
  trend: string
  tone: 'neutral' | 'danger' | 'accent'
}

type TopicCard = {
  title: string
  description: string
  action: string
  backing: string
}

type ActionRun = {
  title: string
  kind: string
  result: string
  timestamp: string
}

type ReportDefinition = {
  id: string
  title: string
  summary: string
  detail: string
  ctaLabel: string
  tone: 'accent' | 'danger' | 'neutral'
}

type Filters = {
  department: string
  type: string
  status: 'All' | AssetStatus
  ownership: 'All' | 'Assigned' | 'Unassigned'
}

type OwnerDraft = {
  assetId: string
  ownerUserId: string
}

type BulkDraft = {
  assetIds: string[]
  action: BulkActionType
  ownerUserId: string
  taskTitle: string
  taskPriority: TaskPriority
}

type AssetDraft = {
  name: string
  assetType: string
  department: string
  ownerUserId: string
  healthStatus: AssetStatus
}

type TaskDraft = {
  title: string
  ownerUserId: string
  dueDate: string
  priority: TaskPriority
  taskType: string
}

const navItems: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', hint: 'Governance posture' },
  { key: 'explorer', label: 'Explorer', hint: 'Metadata assets' },
  { key: 'reports', label: 'Reports', hint: 'Operational insights' },
  { key: 'agent', label: 'Agent Command', hint: 'Agentforce workspace' },
  { key: 'tasks', label: 'Tasks', hint: 'Stewardship queue' }
]

const assetTypeOptions = [
  'Object',
  'Field',
  'Flow',
  'ApexClass',
  'ValidationRule',
  'PermissionSet',
  'Integration',
  'PromptTemplate',
  'Other'
]

const taskTypeOptions = [
  'OwnershipRecovery',
  'Attestation',
  'DuplicateReview',
  'ArchiveReview',
  'Exception'
]

const topicCards: TopicCard[] = [
  {
    title: 'Ownership Recovery',
    description: 'Identify orphaned metadata, recommend the right steward, and launch reassignment flows with confirmation.',
    action: 'Assign owner and notify steward',
    backing: 'Flow + prompt template'
  },
  {
    title: 'Stale Metadata Triage',
    description: 'Detect underused schemas, summarize blast radius, and queue archival or re-attestation tasks.',
    action: 'Run stale review',
    backing: 'Flow + prompt template'
  },
  {
    title: 'Duplicate Cluster Cleanup',
    description: 'Find overlapping assets, compare structure and usage, then draft a remediation plan for approval.',
    action: 'Generate cleanup plan',
    backing: 'Flow + prompt template'
  }
]

const actionRuns: ActionRun[] = [
  {
    title: 'Curator_Get_Metadata_Inventory',
    kind: 'Flow',
    result: 'Returns live inventory metrics that now feed the Dashboard and Explorer directly from Salesforce.',
    timestamp: 'Live'
  },
  {
    title: 'Curator_Run_Stale_Metadata_Review',
    kind: 'Flow',
    result: 'Drives stale review, updates scan history, and records stale governance events in the org.',
    timestamp: 'Live'
  },
  {
    title: 'Curator_Assign_Metadata_Owner',
    kind: 'Flow',
    result: 'Assigns the selected owner and writes the corresponding governance audit event.',
    timestamp: 'Live'
  }
]

const insightCards = [
  {
    title: 'Automated Tagging',
    text: "The agent can now use the persisted inventory and event history to produce more grounded governance recommendations."
  },
  {
    title: 'Stale Data Alerts',
    text: 'Running stale review writes a real scan run and event log, so the Explorer and dashboard stay aligned.'
  },
  {
    title: 'Ownership Risk',
    text: 'Owner reassignment now persists to Metadata Asset records and appears immediately across the app.'
  }
]

const agentSuggestions = [
  'Generate an executive summary and recommend the highest impact action for today.',
  'Review stale metadata in Finance and propose the next remediation step.',
  'Find unassigned security assets and recommend the best owner for each.',
  'Draft a duplicate cleanup plan for Marketing schemas.'
]

const emptyAssetDraft: AssetDraft = {
  name: '',
  assetType: 'Object',
  department: '',
  ownerUserId: '',
  healthStatus: 'Healthy'
}

const emptyTaskDraft: TaskDraft = {
  title: '',
  ownerUserId: '',
  dueDate: '',
  priority: 'High',
  taskType: 'OwnershipRecovery'
}

function App() {
  const agentChat = useAgentChat()
  const [activePage, setActivePage] = useState<PageKey>('dashboard')
  const [assets, setAssets] = useState<GovernanceAsset[]>([])
  const [tasks, setTasks] = useState<GovernanceTask[]>([])
  const [eventLogs, setEventLogs] = useState<GovernanceEventLog[]>([])
  const [users, setUsers] = useState<GovernanceUser[]>([])
  const [currentUser, setCurrentUser] = useState<GovernanceCurrentUser | null>(null)
  const [loadingData, setLoadingData] = useState(true)
  const [isMutating, setIsMutating] = useState(false)
  const [filters, setFilters] = useState<Filters>({
    department: 'All',
    type: 'All',
    status: 'All',
    ownership: 'All'
  })
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([])
  const [showEventLogs, setShowEventLogs] = useState(false)
  const [showExportModal, setShowExportModal] = useState(false)
  const [showNewAssetModal, setShowNewAssetModal] = useState(false)
  const [showNewTaskModal, setShowNewTaskModal] = useState(false)
  const [ownerDraft, setOwnerDraft] = useState<OwnerDraft | null>(null)
  const [bulkDraft, setBulkDraft] = useState<BulkDraft | null>(null)
  const [assetDraft, setAssetDraft] = useState<AssetDraft>(emptyAssetDraft)
  const [taskDraft, setTaskDraft] = useState<TaskDraft>(emptyTaskDraft)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void refreshData()
  }, [])

  const breadcrumb = useMemo(() => {
    const match = navItems.find((item) => item.key === activePage)
    return match?.label ?? 'Dashboard'
  }, [activePage])

  const filteredAssets = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLowerCase()

    return assets.filter((asset) => {
      if (filters.department !== 'All' && asset.department !== filters.department) {
        return false
      }

      if (filters.type !== 'All' && asset.type !== filters.type) {
        return false
      }

      if (filters.status !== 'All' && asset.status !== filters.status) {
        return false
      }

      if (filters.ownership === 'Assigned' && !asset.ownerUserId) {
        return false
      }

      if (filters.ownership === 'Unassigned' && asset.ownerUserId) {
        return false
      }

      if (!normalizedSearch) {
        return true
      }

      const haystack = [
        asset.name,
        asset.apiName,
        asset.id,
        asset.type,
        asset.department,
        asset.ownerName ?? 'Unassigned',
        asset.sourceSystem ?? ''
      ]
        .join(' ')
        .toLowerCase()

      return haystack.includes(normalizedSearch)
    })
  }, [assets, filters, searchQuery])

  const departmentOptions = useMemo(
    () => ['All', ...new Set(assets.map((asset) => asset.department).filter(Boolean))],
    [assets]
  )
  const typeOptions = useMemo(() => ['All', ...new Set(assets.map((asset) => asset.type).filter(Boolean))], [assets])

  const totalAssets = assets.length
  const staleCount = assets.filter((asset) => asset.status === 'Stale').length
  const duplicateCount = assets.filter((asset) => asset.status === 'Duplicate').length
  const unassignedCount = assets.filter((asset) => !asset.ownerUserId).length
  const ownershipCoverage = totalAssets === 0 ? 0 : ((totalAssets - unassignedCount) / totalAssets) * 100
  const healthScore =
    totalAssets === 0
      ? 0
      : assets.reduce((sum, asset) => sum + (asset.healthScore ?? 0), 0) / totalAssets

  const ownershipBars = useMemo(() => {
    const grouped = new Map<string, { total: number; covered: number }>()

    assets.forEach((asset) => {
      const key = asset.department || 'Unspecified'
      const current = grouped.get(key) ?? { total: 0, covered: 0 }
      current.total += 1
      current.covered += asset.ownerUserId ? 1 : 0
      grouped.set(key, current)
    })

    return [...grouped.entries()]
      .map(([label, counts]) => ({
        label,
        value: counts.total === 0 ? 0 : Math.round((counts.covered / counts.total) * 100)
      }))
      .sort((left, right) => right.value - left.value)
      .slice(0, 4)
  }, [assets])

  const dashboardStats: StatCard[] = [
    {
      label: 'Ownership Coverage',
      value: `${ownershipCoverage.toFixed(1)}%`,
      helper: 'Coverage across active metadata assets',
      trend: unassignedCount > 0 ? `${unassignedCount} open` : 'Covered',
      tone: unassignedCount > 0 ? 'accent' : 'neutral'
    },
    {
      label: 'Stale Metadata',
      value: staleCount.toLocaleString(),
      helper: 'Assets requiring re-attestation or archival review',
      trend: staleCount > 0 ? `${staleCount} flagged` : 'Clear',
      tone: staleCount > 0 ? 'accent' : 'neutral'
    },
    {
      label: 'Duplicate Clusters',
      value: duplicateCount.toLocaleString(),
      helper: `Potential redundancy reduction: $${(duplicateCount * 350).toLocaleString()}/mo`,
      trend: duplicateCount > 0 ? `${duplicateCount} active` : 'None',
      tone: duplicateCount > 0 ? 'danger' : 'neutral'
    }
  ]

  const explorerStats: StatCard[] = [
    {
      label: 'Total Assets',
      value: totalAssets.toLocaleString(),
      helper: `${filteredAssets.length.toLocaleString()} in current view`,
      trend: searchQuery ? 'Filtered' : 'Live',
      tone: 'accent'
    },
    {
      label: 'Unassigned',
      value: unassignedCount.toLocaleString(),
      helper: unassignedCount > 0 ? 'Critical governance gap' : 'Ownership baseline met',
      trend: unassignedCount > 0 ? 'Urgent' : 'Stable',
      tone: unassignedCount > 0 ? 'danger' : 'neutral'
    },
    {
      label: 'Health Score',
      value: `${healthScore.toFixed(1)}%`,
      helper: 'Calculated from persisted asset inventory',
      trend: healthScore >= 90 ? 'Healthy' : 'Needs review',
      tone: healthScore >= 90 ? 'accent' : 'danger'
    }
  ]

  const reportHighlights = [
    {
      title: 'Executive Brief',
      text: `Ownership coverage is ${ownershipCoverage.toFixed(1)}%, with ${unassignedCount} assets still lacking a steward.`
    },
    {
      title: 'Remediation Yield',
      text: `${duplicateCount} duplicate clusters are still open, representing roughly $${(duplicateCount * 350).toLocaleString()} in avoidable monthly overlap.`
    },
    {
      title: 'Stale Exposure',
      text: `${staleCount} assets are currently marked stale and should be reviewed for archival or re-attestation.`
    }
  ]

  function applyBootstrap(payload: GovernanceBootstrap) {
    setCurrentUser(payload.currentUser)
    setAssets(payload.assets)
    setTasks(payload.tasks)
    setEventLogs(payload.eventLogs)
    setUsers(payload.users)
  }

  async function refreshData() {
    setLoadingData(true)
    try {
      const payload = await fetchGovernanceBootstrap()
      applyBootstrap(payload)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to load governance data.')
    } finally {
      setLoadingData(false)
    }
  }

  async function runMutation(
    work: () => Promise<GovernanceBootstrap>,
    successMessage: string,
    afterSuccess?: () => void
  ) {
    setIsMutating(true)
    try {
      const payload = await work()
      applyBootstrap(payload)
      setNotice(successMessage)
      afterSuccess?.()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Something went wrong while saving to Salesforce.')
    } finally {
      setIsMutating(false)
    }
  }

  async function handleExportAction(format: 'csv' | 'pdf', afterLog: () => void) {
    await runMutation(
      () =>
        recordGovernanceExport({
          format,
          rowCount: filteredAssets.length,
          department: filters.department,
          type: filters.type,
          status: filters.status,
          ownership: filters.ownership
        }),
      `${format.toUpperCase()} export logged in Salesforce.`,
      () => {
        afterLog()
        setShowExportModal(false)
      }
    )
  }

  function handleToggleSelection(assetId: string) {
    setSelectedAssetIds((current) =>
      current.includes(assetId) ? current.filter((id) => id !== assetId) : [...current, assetId]
    )
  }

  function handleToggleAllVisible() {
    const visibleIds = filteredAssets.map((asset) => asset.id)
    const allVisibleSelected = visibleIds.every((id) => selectedAssetIds.includes(id))

    setSelectedAssetIds((current) => {
      if (allVisibleSelected) {
        return current.filter((id) => !visibleIds.includes(id))
      }

      return [...new Set([...current, ...visibleIds])]
    })
  }

  function handleClearFilters() {
    setFilters({
      department: 'All',
      type: 'All',
      status: 'All',
      ownership: 'All'
    })
    setSelectedAssetIds([])
    setNotice('Explorer filters reset.')
  }

  function openAssignOwner(asset: GovernanceAsset) {
    setOwnerDraft({
      assetId: asset.id,
      ownerUserId: asset.ownerUserId ?? ''
    })
  }

  function openBulkActions(mode: 'selected' | 'filtered') {
    const assetIds =
      mode === 'selected'
        ? selectedAssetIds
        : filteredAssets.filter((asset) => asset.status !== 'Healthy' || !asset.ownerUserId).map((asset) => asset.id)

    if (assetIds.length === 0) {
      setNotice('Select assets or filter to a remediation slice before running a bulk action.')
      return
    }

    setBulkDraft({
      assetIds,
      action: 'create_task',
      ownerUserId: '',
      taskTitle: 'Remediate metadata asset',
      taskPriority: 'High'
    })
  }

  const selectedOwner = ownerDraft ? users.find((user) => user.id === ownerDraft.ownerUserId) : null
  const profileLabel = currentUser?.roleLabel ?? 'Salesforce Admin'
  const usernameLabel = currentUser?.username ?? 'Loading user...'
  const currentUserDisplayName = currentUser?.name ?? 'Metadata Admin'
  const avatarLabel = currentUserDisplayName
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((segment) => segment[0]?.toUpperCase())
    .join('')
    .slice(0, 2)

  if (loadingData) {
    return (
      <div className="app-shell">
        <main className="main-panel">
          <section className="content-area">
            <article className="panel">
              <h2>Loading Data Curator</h2>
              <p className="hero-copy">Fetching metadata assets, tasks, event logs, and user assignments from Salesforce.</p>
            </article>
          </section>
        </main>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <div className="brand">
            <div className="brand-mark">Metadata Management Center</div>
            <div className="brand-subtitle">{usernameLabel}</div>
          </div>

          <nav className="nav-list" aria-label="Primary">
            {navItems.map((item) => (
              <button
                key={item.key}
                className={`nav-item ${item.key === activePage ? 'active' : ''}`}
                onClick={() => setActivePage(item.key)}
                type="button"
              >
                <span className="nav-icon">{iconForPage(item.key)}</span>
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.hint}</small>
                </span>
              </button>
            ))}
          </nav>
        </div>

        <div className="sidebar-footer">
          <button
            className="sidebar-cta"
            type="button"
            onClick={() => {
              setAssetDraft(emptyAssetDraft)
              setShowNewAssetModal(true)
            }}
          >
            <span className="cta-plus">+</span>
            New Asset
          </button>
          <div className="profile-card">
            <div className="avatar">{avatarLabel || 'MM'}</div>
            <div>
              <strong>{usernameLabel}</strong>
              <small>{profileLabel}</small>
            </div>
          </div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="search-box">
            <span className="topbar-icon">{searchIcon}</span>
            <input
              aria-label="Search metadata assets"
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={
                activePage === 'agent'
                  ? 'Ask the curator agent about stale assets, ownership, or duplicates...'
                  : 'Search metadata assets, owners, departments, or tags...'
              }
              value={searchQuery}
            />
          </div>

          <div className="topbar-actions">
            <button className="icon-button" type="button" aria-label="Notifications" onClick={() => setShowEventLogs(true)}>
              {bellIcon}
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="Refresh"
              onClick={() => void refreshData()}
              disabled={isMutating}
            >
              {refreshIcon}
            </button>
            <div className="breadcrumb">
              <strong>{breadcrumb}</strong>
              <span>{currentUserDisplayName}</span>
            </div>
          </div>
        </header>

        <section className="content-area">
          <div className="page-stack">
            {notice && (
              <div className="notice-banner">
                <span>{notice}</span>
                <button className="text-button" type="button" onClick={() => setNotice(null)}>
                  Dismiss
                </button>
              </div>
            )}

            {activePage === 'dashboard' && (
              <DashboardPage
                stats={dashboardStats}
                ownershipBars={ownershipBars}
                recentActivity={eventLogs.slice(0, 3)}
                onReviewStaleData={() =>
                  void runMutation(
                    () => runGovernanceStaleReview({ staleThresholdDays: 180 }),
                    'Stale review completed and Explorer focused on stale assets.',
                    () => {
                      setActivePage('explorer')
                      setFilters((current) => ({ ...current, status: 'Stale' }))
                    }
                  )
                }
                onRunFullScan={() =>
                  void runMutation(
                    () => runGovernanceFullScan(),
                    'Full scan completed and imported existing org metadata into Salesforce.'
                  )
                }
                onOpenEventLogs={() => setShowEventLogs(true)}
                isBusy={isMutating}
              />
            )}

            {activePage === 'explorer' && (
              <ExplorerPage
                assets={filteredAssets}
                filters={filters}
                stats={explorerStats}
                departmentOptions={departmentOptions}
                typeOptions={typeOptions}
                selectedAssetIds={selectedAssetIds}
                totalAssets={assets.length}
                onFilterChange={(next) => setFilters((current) => ({ ...current, ...next }))}
                onClearFilters={handleClearFilters}
                onToggleSelection={handleToggleSelection}
                onToggleAllVisible={handleToggleAllVisible}
                onOpenBulkAction={openBulkActions}
                onOpenExport={() => setShowExportModal(true)}
                onAssignOwner={openAssignOwner}
                isBusy={isMutating}
              />
            )}

            {activePage === 'reports' && (
              <ReportsPage
                assets={assets}
                eventLogs={eventLogs}
                highlights={reportHighlights}
                tasks={tasks}
              />
            )}
            {activePage === 'agent' && <AgentPage {...agentChat} />}
            {activePage === 'tasks' && (
              <TasksPage
                tasks={tasks}
                onAddTask={() => {
                  setTaskDraft(emptyTaskDraft)
                  setShowNewTaskModal(true)
                }}
              />
            )}
          </div>
        </section>
      </main>

      {showEventLogs && (
        <ModalShell
          title="Event Logs"
          subtitle="Review all scan runs, stewardship changes, exports, and remediation actions."
          onClose={() => setShowEventLogs(false)}
        >
          <div className="log-list">
            {eventLogs.map((item) => (
              <div key={item.id} className="log-item">
                <div className={`activity-badge ${item.tone}`}>{activityIcon(item.tone)}</div>
                <div className="activity-copy">
                  <strong>{item.title}</strong>
                  <p>{item.details}</p>
                </div>
                <div className="activity-meta">
                  <span>{item.timeLabel}</span>
                  <mark className={`tag ${toneToTag(item.tone)}`}>{item.badge}</mark>
                </div>
              </div>
            ))}
          </div>
        </ModalShell>
      )}

      {showExportModal && (
        <ModalShell
          title="Export Current View"
          subtitle={`Export ${filteredAssets.length} Explorer rows using the filters currently applied.`}
          onClose={() => setShowExportModal(false)}
        >
          <div className="modal-actions">
            <button
              className="ghost-button"
              type="button"
              onClick={() =>
                void handleExportAction('csv', () => {
                  const rows = filteredAssets.map((asset) => ({
                    Name: asset.name,
                    ApiName: asset.apiName,
                    Id: asset.id,
                    Type: asset.type,
                    Department: asset.department,
                    Owner: asset.ownerName ?? 'Unassigned',
                    Status: asset.status,
                    HealthScore: String(asset.healthScore)
                  }))
                  downloadFile(`data-curator-assets-${Date.now()}.csv`, toCsv(rows), 'text/csv;charset=utf-8;')
                })
              }
              disabled={isMutating}
            >
              Download CSV
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={() =>
                void handleExportAction('pdf', () => {
                  const printWindow = window.open('', '_blank', 'width=1080,height=820')
                  if (!printWindow) {
                    setNotice('Allow pop-ups in the browser to print the current view as PDF.')
                    return
                  }
                  printWindow.document.write(buildPrintableTable(filteredAssets))
                  printWindow.document.close()
                  printWindow.focus()
                  window.setTimeout(() => printWindow.print(), 200)
                })
              }
              disabled={isMutating}
            >
              Print / PDF
            </button>
          </div>
        </ModalShell>
      )}

      {ownerDraft && (
        <ModalShell
          title="Assign Owner"
          subtitle={`Update stewardship for ${assets.find((asset) => asset.id === ownerDraft.assetId)?.name ?? 'this asset'}.`}
          onClose={() => setOwnerDraft(null)}
        >
          <div className="modal-form">
            <label className="field">
              <span>Owner</span>
              <select
                value={ownerDraft.ownerUserId}
                onChange={(event) =>
                  setOwnerDraft((current) => (current ? { ...current, ownerUserId: event.target.value } : current))
                }
              >
                <option value="">Select an owner</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="modal-actions">
              <button className="ghost-button" type="button" onClick={() => setOwnerDraft(null)}>
                Cancel
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={!ownerDraft.ownerUserId || isMutating}
                onClick={() =>
                  void runMutation(
                    () =>
                      assignGovernanceOwner({
                        assetId: ownerDraft.assetId,
                        ownerUserId: ownerDraft.ownerUserId
                      }),
                    `Assigned ${selectedOwner?.name ?? 'the selected owner'} successfully.`,
                    () => setOwnerDraft(null)
                  )
                }
              >
                Save Owner
              </button>
            </div>
          </div>
        </ModalShell>
      )}

      {bulkDraft && (
        <ModalShell
          title="Bulk Actions"
          subtitle={`Applying actions to ${bulkDraft.assetIds.length} assets in the current scope.`}
          onClose={() => setBulkDraft(null)}
        >
          <div className="modal-form">
            <label className="field">
              <span>Action</span>
              <select
                value={bulkDraft.action}
                onChange={(event) =>
                  setBulkDraft((current) =>
                    current ? { ...current, action: event.target.value as BulkActionType } : current
                  )
                }
              >
                <option value="create_task">Create remediation tasks</option>
                <option value="assign_owner">Assign owner in bulk</option>
                <option value="mark_healthy">Mark healthy after review</option>
              </select>
            </label>

            {bulkDraft.action === 'assign_owner' && (
              <label className="field">
                <span>Owner</span>
                <select
                  value={bulkDraft.ownerUserId}
                  onChange={(event) =>
                    setBulkDraft((current) => (current ? { ...current, ownerUserId: event.target.value } : current))
                  }
                >
                  <option value="">Select an owner</option>
                  {users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {bulkDraft.action === 'create_task' && (
              <>
                <label className="field">
                  <span>Task Title Prefix</span>
                  <input
                    value={bulkDraft.taskTitle}
                    onChange={(event) =>
                      setBulkDraft((current) => (current ? { ...current, taskTitle: event.target.value } : current))
                    }
                    placeholder="Remediate metadata asset"
                  />
                </label>
                <label className="field">
                  <span>Priority</span>
                  <select
                    value={bulkDraft.taskPriority}
                    onChange={(event) =>
                      setBulkDraft((current) =>
                        current ? { ...current, taskPriority: event.target.value as TaskPriority } : current
                      )
                    }
                  >
                    <option value="Low">Low</option>
                    <option value="Medium">Medium</option>
                    <option value="High">High</option>
                    <option value="Critical">Critical</option>
                  </select>
                </label>
              </>
            )}

            <div className="modal-actions">
              <button className="ghost-button" type="button" onClick={() => setBulkDraft(null)}>
                Cancel
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={isMutating || (bulkDraft.action === 'assign_owner' && !bulkDraft.ownerUserId)}
                onClick={() =>
                  void runMutation(
                    () =>
                      runGovernanceBulkAction({
                        assetIds: bulkDraft.assetIds,
                        action: bulkDraft.action,
                        ownerUserId: bulkDraft.ownerUserId || undefined,
                        taskTitle: bulkDraft.taskTitle,
                        taskPriority: bulkDraft.taskPriority
                      }),
                    'Bulk action completed successfully.',
                    () => {
                      setBulkDraft(null)
                      setSelectedAssetIds([])
                    }
                  )
                }
              >
                Apply Bulk Action
              </button>
            </div>
          </div>
        </ModalShell>
      )}

      {showNewAssetModal && (
        <ModalShell
          title="Create New Asset"
          subtitle="Add a new metadata record to the inventory and optionally assign stewardship."
          onClose={() => setShowNewAssetModal(false)}
        >
          <div className="modal-form">
            <label className="field">
              <span>Asset Name</span>
              <input
                value={assetDraft.name}
                onChange={(event) => setAssetDraft((current) => ({ ...current, name: event.target.value }))}
                placeholder="example_metadata_asset"
              />
            </label>
            <div className="field-grid">
              <label className="field">
                <span>Type</span>
                <select
                  value={assetDraft.assetType}
                  onChange={(event) => setAssetDraft((current) => ({ ...current, assetType: event.target.value }))}
                >
                  {assetTypeOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Status</span>
                <select
                  value={assetDraft.healthStatus}
                  onChange={(event) =>
                    setAssetDraft((current) => ({ ...current, healthStatus: event.target.value as AssetStatus }))
                  }
                >
                  {['Healthy', 'Stale', 'Duplicate', 'NeedsReview'].map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              <span>Department</span>
              <input
                value={assetDraft.department}
                onChange={(event) => setAssetDraft((current) => ({ ...current, department: event.target.value }))}
                placeholder="Marketing"
              />
            </label>
            <label className="field">
              <span>Owner</span>
              <select
                value={assetDraft.ownerUserId}
                onChange={(event) => setAssetDraft((current) => ({ ...current, ownerUserId: event.target.value }))}
              >
                <option value="">Unassigned</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="modal-actions">
              <button className="ghost-button" type="button" onClick={() => setShowNewAssetModal(false)}>
                Cancel
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={!assetDraft.name.trim() || !assetDraft.department.trim() || isMutating}
                onClick={() =>
                  void runMutation(
                    () =>
                      createGovernanceAsset({
                        name: assetDraft.name.trim(),
                        assetType: assetDraft.assetType,
                        department: assetDraft.department.trim(),
                        ownerUserId: assetDraft.ownerUserId || undefined,
                        healthStatus: assetDraft.healthStatus
                      }),
                    `${assetDraft.name.trim()} created successfully.`,
                    () => {
                      setAssetDraft(emptyAssetDraft)
                      setShowNewAssetModal(false)
                      setActivePage('explorer')
                    }
                  )
                }
              >
                Create Asset
              </button>
            </div>
          </div>
        </ModalShell>
      )}

      {showNewTaskModal && (
        <ModalShell
          title="Add Task"
          subtitle="Create a stewardship follow-up for the admin or review board."
          onClose={() => setShowNewTaskModal(false)}
        >
          <div className="modal-form">
            <label className="field">
              <span>Task Title</span>
              <input
                value={taskDraft.title}
                onChange={(event) => setTaskDraft((current) => ({ ...current, title: event.target.value }))}
                placeholder="Review new duplicate cluster"
              />
            </label>
            <div className="field-grid">
              <label className="field">
                <span>Owner</span>
                <select
                  value={taskDraft.ownerUserId}
                  onChange={(event) => setTaskDraft((current) => ({ ...current, ownerUserId: event.target.value }))}
                >
                  <option value="">Assign later</option>
                  {users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Due Date</span>
                <input
                  type="date"
                  value={taskDraft.dueDate}
                  onChange={(event) => setTaskDraft((current) => ({ ...current, dueDate: event.target.value }))}
                />
              </label>
            </div>
            <div className="field-grid">
              <label className="field">
                <span>Priority</span>
                <select
                  value={taskDraft.priority}
                  onChange={(event) =>
                    setTaskDraft((current) => ({ ...current, priority: event.target.value as TaskPriority }))
                  }
                >
                  <option value="Low">Low</option>
                  <option value="Medium">Medium</option>
                  <option value="High">High</option>
                  <option value="Critical">Critical</option>
                </select>
              </label>
              <label className="field">
                <span>Task Type</span>
                <select
                  value={taskDraft.taskType}
                  onChange={(event) => setTaskDraft((current) => ({ ...current, taskType: event.target.value }))}
                >
                  {taskTypeOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="modal-actions">
              <button className="ghost-button" type="button" onClick={() => setShowNewTaskModal(false)}>
                Cancel
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={!taskDraft.title.trim() || isMutating}
                onClick={() =>
                  void runMutation(
                    () =>
                      createGovernanceTask({
                        title: taskDraft.title.trim(),
                        ownerUserId: taskDraft.ownerUserId || undefined,
                        dueDate: taskDraft.dueDate || undefined,
                        priority: taskDraft.priority,
                        taskType: taskDraft.taskType
                      }),
                    `Added task: ${taskDraft.title.trim()}.`,
                    () => {
                      setTaskDraft(emptyTaskDraft)
                      setShowNewTaskModal(false)
                    }
                  )
                }
              >
                Add Task
              </button>
            </div>
          </div>
        </ModalShell>
      )}
    </div>
  )
}

function DashboardPage({
  stats,
  ownershipBars,
  recentActivity,
  onReviewStaleData,
  onRunFullScan,
  onOpenEventLogs,
  isBusy
}: {
  stats: StatCard[]
  ownershipBars: Array<{ label: string; value: number }>
  recentActivity: GovernanceEventLog[]
  onReviewStaleData: () => void
  onRunFullScan: () => void
  onOpenEventLogs: () => void
  isBusy: boolean
}) {
  return (
    <>
      <section className="hero-row">
        <div>
          <div className="eyebrow">Governance Oversight</div>
          <h1>Executive Summary</h1>
        </div>
        <div className="hero-actions">
          <button className="ghost-button" type="button" onClick={onReviewStaleData} disabled={isBusy}>
            Review Stale Data
          </button>
          <button className="primary-button" type="button" onClick={onRunFullScan} disabled={isBusy}>
            Run Full Scan
          </button>
        </div>
      </section>

      <section className="card-grid stats-grid">
        {stats.map((card) => (
          <MetricCard key={card.label} card={card} />
        ))}
      </section>

      <section className="card-grid dashboard-grid">
        <article className="panel panel-large">
          <div className="panel-header">
            <h2>Ownership by Department</h2>
            <span className="legend">Covered · Unassigned</span>
          </div>
          <div className="bar-list">
            {ownershipBars.map((item) => (
              <div key={item.label} className="bar-row">
                <div className="bar-copy">
                  <strong>{item.label}</strong>
                  <span>{item.value}%</span>
                </div>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${item.value}%` }} />
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="panel">
          <div className="panel-header">
            <div>
              <h2>Metadata Health Trend</h2>
              <span className="panel-subtitle">Last 30 days activity</span>
            </div>
          </div>
          <HealthChart />
        </article>
      </section>

      <article className="panel">
        <div className="panel-header">
          <h2>Recent Activity</h2>
          <button className="text-button" type="button" onClick={onOpenEventLogs}>
            View All Event Logs
          </button>
        </div>
        <div className="activity-list">
          {recentActivity.map((item) => (
            <div key={item.id} className="activity-item">
              <div className={`activity-badge ${item.tone}`}>{activityIcon(item.tone)}</div>
              <div className="activity-copy">
                <strong>{item.title}</strong>
                <p>{item.details}</p>
              </div>
              <div className="activity-meta">
                <span>{item.timeLabel}</span>
                <mark className={`tag ${toneToTag(item.tone)}`}>{item.badge}</mark>
              </div>
            </div>
          ))}
        </div>
      </article>
    </>
  )
}

function ExplorerPage({
  assets,
  filters,
  stats,
  departmentOptions,
  typeOptions,
  selectedAssetIds,
  totalAssets,
  onFilterChange,
  onClearFilters,
  onToggleSelection,
  onToggleAllVisible,
  onOpenBulkAction,
  onOpenExport,
  onAssignOwner,
  isBusy
}: {
  assets: GovernanceAsset[]
  filters: Filters
  stats: StatCard[]
  departmentOptions: string[]
  typeOptions: string[]
  selectedAssetIds: string[]
  totalAssets: number
  onFilterChange: (next: Partial<Filters>) => void
  onClearFilters: () => void
  onToggleSelection: (assetId: string) => void
  onToggleAllVisible: () => void
  onOpenBulkAction: (mode: 'selected' | 'filtered') => void
  onOpenExport: () => void
  onAssignOwner: (asset: GovernanceAsset) => void
  isBusy: boolean
}) {
  const allVisibleSelected = assets.length > 0 && assets.every((asset) => selectedAssetIds.includes(asset.id))

  return (
    <>
      <section className="hero-block">
        <div className="eyebrow">Explorer / All Assets</div>
        <h1>Metadata Explorer</h1>
        <p className="hero-copy">
          Governance console for your Salesforce estate. Catalog, validate, and assign stewardship across
          objects, fields, integrations, and automation.
        </p>
      </section>

      <section className="card-grid explorer-top-grid">
        {stats.map((card) => (
          <MetricCard key={card.label} card={card} compact />
        ))}
        <article className="panel callout-card">
          <div className="callout-copy">
            <h2>Bulk Remediation</h2>
            <p>Target the filtered view or a selected set of rows, then assign owners, create tasks, or mark the slice healthy.</p>
          </div>
          <button className="secondary-invert" type="button" onClick={() => onOpenBulkAction('filtered')} disabled={isBusy}>
            Run Bulk Action
          </button>
        </article>
      </section>

      <section className="toolbar">
        <div className="filter-row">
          <label className="filter-select">
            <span>Department</span>
            <select value={filters.department} onChange={(event) => onFilterChange({ department: event.target.value })}>
              {departmentOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <label className="filter-select">
            <span>Type</span>
            <select value={filters.type} onChange={(event) => onFilterChange({ type: event.target.value })}>
              {typeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <label className="filter-select">
            <span>Status</span>
            <select
              value={filters.status}
              onChange={(event) => onFilterChange({ status: event.target.value as Filters['status'] })}
            >
              {['All', 'Healthy', 'Stale', 'Duplicate', 'NeedsReview'].map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <label className="filter-select">
            <span>Owner</span>
            <select
              value={filters.ownership}
              onChange={(event) => onFilterChange({ ownership: event.target.value as Filters['ownership'] })}
            >
              <option value="All">All</option>
              <option value="Assigned">Assigned</option>
              <option value="Unassigned">Unassigned</option>
            </select>
          </label>

          <button className="text-button" type="button" onClick={onClearFilters}>
            Clear Filters
          </button>
        </div>
        <div className="filter-row">
          <button className="ghost-button" type="button" onClick={onOpenExport}>
            Export
          </button>
          <button className="primary-dark" type="button" onClick={() => onOpenBulkAction('selected')} disabled={isBusy}>
            Bulk Actions
          </button>
        </div>
      </section>

      <article className="panel table-panel">
        <div className="selection-summary">
          <span>{selectedAssetIds.length} selected</span>
          <span>{assets.length} in view</span>
        </div>
        <div className="asset-table">
          <div className="asset-header">
            <span>
              <input type="checkbox" checked={allVisibleSelected} onChange={onToggleAllVisible} aria-label="Select all visible assets" />
            </span>
            <span>Asset Name</span>
            <span>Type</span>
            <span>Department</span>
            <span>Owner</span>
            <span>Health Status</span>
            <span>Actions</span>
          </div>
          {assets.map((asset) => (
            <div key={asset.id} className="asset-row">
              <div>
                <input
                  type="checkbox"
                  checked={selectedAssetIds.includes(asset.id)}
                  onChange={() => onToggleSelection(asset.id)}
                  aria-label={`Select ${asset.name}`}
                />
              </div>
              <div>
                <strong>{asset.name}</strong>
                <small>{asset.apiName || asset.id}</small>
              </div>
              <div>
                <span className="type-pill">{asset.type}</span>
              </div>
              <div>{asset.department}</div>
              <div className="owner-cell">
                <span className="owner-avatar">{getInitials(asset.ownerName ?? 'UA')}</span>
                <span>{asset.ownerName ?? 'Unassigned'}</span>
              </div>
              <div className={`status-pill ${statusTone(asset.status)}`}>{asset.status}</div>
              <div>
                <button className="table-action" type="button" onClick={() => onAssignOwner(asset)} disabled={isBusy}>
                  Assign Owner
                </button>
              </div>
            </div>
          ))}
          {assets.length === 0 && <div className="empty-state">No assets match the current filter set.</div>}
        </div>
        <div className="table-footer">
          <span>
            Showing {assets.length.toLocaleString()} of {totalAssets.toLocaleString()} assets
          </span>
          <span>{selectedAssetIds.length > 0 ? `${selectedAssetIds.length} selected` : 'Ready for action'}</span>
        </div>
      </article>

      <section className="card-grid insight-grid">
        {insightCards.map((card) => (
          <article key={card.title} className="insight-card">
            <h3>{card.title}</h3>
            <p>{card.text}</p>
          </article>
        ))}
      </section>
    </>
  )
}

function renderInlineRichText(text: string, keyPrefix: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean)

  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={`${keyPrefix}-${index}`}>{part.slice(2, -2)}</strong>
    }

    return <span key={`${keyPrefix}-${index}`}>{part}</span>
  })
}

function renderFormattedMessage(text: string, keyPrefix: string) {
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)

  return blocks.map((block, blockIndex) => {
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)

    if (lines.length > 0 && lines.every((line) => /^([-*]|\d+\.)\s+/.test(line))) {
      return (
        <ul key={`${keyPrefix}-list-${blockIndex}`} className="rich-list">
          {lines.map((line, lineIndex) => (
            <li key={`${keyPrefix}-item-${blockIndex}-${lineIndex}`}>
              {renderInlineRichText(line.replace(/^([-*]|\d+\.)\s+/, ''), `${keyPrefix}-${blockIndex}-${lineIndex}`)}
            </li>
          ))}
        </ul>
      )
    }

    return (
      <p key={`${keyPrefix}-paragraph-${blockIndex}`}>
        {renderInlineRichText(block, `${keyPrefix}-${blockIndex}`)}
      </p>
    )
  })
}

function AgentPage({
  draft,
  isSending,
  messages,
  processingNote,
  resetSession,
  sessionId,
  setDraft,
  status,
  statusNote,
  submitMessage
}: ReturnType<typeof useAgentChat>) {
  const chatThreadRef = useRef<HTMLDivElement | null>(null)
  const statusLabel =
    status === 'ready'
      ? 'Agent API Ready'
      : status === 'misconfigured'
        ? 'Needs Configuration'
        : status === 'checking'
          ? 'Checking Agent'
          : 'Agent Error'

  useEffect(() => {
    const container = chatThreadRef.current
    if (!container) {
      return
    }

    container.scrollTop = container.scrollHeight
  }, [isSending, messages])

  return (
    <>
      <section className="hero-row">
        <div>
          <div className="eyebrow">Agentforce Operations</div>
          <h1>Agent Command Center</h1>
          <p className="hero-copy">
            A governance copilot designed for Salesforce admins. It routes requests into topics, triggers Flow
            actions, and uses prompt templates to produce audit-friendly summaries and remediation drafts.
          </p>
        </div>
        <div className="status-cluster">
          <span className={`status-indicator ${status}`}>{statusLabel}</span>
          <button
            className="primary-button"
            type="button"
            onClick={() =>
              void submitMessage('Generate an executive summary and propose the highest impact action for today.')
            }
          >
            Launch Remediation Plan
          </button>
        </div>
      </section>

      <section className="agent-layout">
        <article className="panel command-console">
          <div className="panel-header">
            <div>
              <h2>Live Agent Chat</h2>
              <p className="chat-subheading">The conversation stays here. Suggested prompts and topic shortcuts live in the rail beside it.</p>
            </div>
            <span className="legend">{statusNote}</span>
          </div>
          <div className="agent-toolbar">
            <span className="session-chip">{sessionId ? `Session ${sessionId.slice(0, 8)}` : 'No active session'}</span>
            <button className="text-button" type="button" onClick={() => void resetSession()}>
              Reset conversation
            </button>
          </div>
          <div className="chat-thread-shell">
            <div className="chat-thread" ref={chatThreadRef}>
            {messages.map((message) => (
              <div key={message.id} className={`chat-message ${message.role === 'assistant' ? 'bot' : message.role}`}>
                <div className="chat-message-label">
                  {message.role === 'assistant' ? 'Agent' : message.role === 'user' ? 'You' : 'System'}
                </div>
                <div className="chat-message-body">{renderFormattedMessage(message.text, message.id)}</div>
                {message.citations && message.citations.length > 0 && (
                  <div className="citation-row">
                    {message.citations.map((citation) => (
                      <a
                        key={`${message.id}-${citation.title}`}
                        href={citation.url}
                        rel="noreferrer"
                        target="_blank"
                        className="citation-pill"
                      >
                        {citation.title}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ))}
              {isSending && (
                <div className="chat-message system">
                  <div className="chat-message-label">Agent</div>
                  <div className="chat-message-body">
                    <p>{processingNote}</p>
                  </div>
                </div>
              )}
            </div>
          </div>
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault()
              void submitMessage(draft)
            }}
          >
            <input
              aria-label="Agent prompt"
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Ask the agent to scan metadata, assign owners, or draft a governance brief..."
              value={draft}
            />
            <button className="primary-button" type="submit" disabled={isSending || status === 'misconfigured'}>
              {isSending ? 'Running...' : 'Run'}
            </button>
          </form>
        </article>

        <div className="agent-side-rail">
          <article className="panel suggestion-panel">
            <div className="panel-header">
              <div>
                <h2>Suggested Prompts</h2>
                <p className="chat-subheading">Use these for a fast start without crowding the active chat panel.</p>
              </div>
            </div>
            <div className="prompt-stack">
              {agentSuggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  className="prompt-card"
                  type="button"
                  onClick={() => void submitMessage(suggestion)}
                  disabled={isSending}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </article>

          <div className="topic-column">
            {topicCards.map((topic) => (
              <article key={topic.title} className="panel topic-card">
                <div className="topic-topline">{topic.backing}</div>
                <h3>{topic.title}</h3>
                <p>{topic.description}</p>
                <button className="ghost-button" type="button" onClick={() => void submitMessage(topic.action)}>
                  {topic.action}
                </button>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="card-grid lower-agent-grid">
        <article className="panel">
          <div className="panel-header">
            <h2>Recent Action Runs</h2>
            <span className="legend">Live execution rail</span>
          </div>
          <div className="run-list">
            {actionRuns.map((run) => (
              <div key={run.title} className="run-item">
                <div>
                  <strong>{run.title}</strong>
                  <small>{run.kind}</small>
                </div>
                <p>{run.result}</p>
                <span>{run.timestamp}</span>
              </div>
            ))}
          </div>
        </article>

        <article className="panel architecture-panel">
          <div className="panel-header">
            <h2>Delivery Shape</h2>
          </div>
          <ul className="architecture-list">
            <li>The web app now loads real assets, tasks, users, and governance events directly from Salesforce.</li>
            <li>Full scan now imports existing org metadata such as custom objects, custom fields, flows, Apex classes, validation rules, and permission sets before refreshing the audit.</li>
            <li>Agent Command remains available for Agentforce-driven reasoning on top of the same governance data model.</li>
            <li>Explorer exports still download client-side, and each export is now written back to Salesforce as an audit event.</li>
          </ul>
        </article>
      </section>
    </>
  )
}

function ReportsPage({
  assets,
  eventLogs,
  highlights,
  tasks
}: {
  assets: GovernanceAsset[]
  eventLogs: GovernanceEventLog[]
  highlights: Array<{ title: string; text: string }>
  tasks: GovernanceTask[]
}) {
  const ownershipCoverage =
    assets.length === 0 ? 0 : ((assets.length - assets.filter((asset) => !asset.ownerUserId).length) / assets.length) * 100
  const staleAssets = assets.filter((asset) => asset.status === 'Stale')
  const duplicateAssets = assets.filter((asset) => asset.status === 'Duplicate')
  const ownerLoad = Object.values(
    assets.reduce<Record<string, { ownerName: string; assetCount: number; healthyCount: number }>>((accumulator, asset) => {
      const key = asset.ownerName ?? 'Unassigned'
      const existing = accumulator[key] ?? { ownerName: key, assetCount: 0, healthyCount: 0 }

      existing.assetCount += 1
      if (asset.status === 'Healthy') {
        existing.healthyCount += 1
      }

      accumulator[key] = existing
      return accumulator
    }, {})
  )
    .sort((left, right) => right.assetCount - left.assetCount)
    .slice(0, 6)

  const reportDefinitions: ReportDefinition[] = [
    {
      id: 'executive-brief',
      title: 'Executive Brief',
      summary: `${ownershipCoverage.toFixed(1)}% ownership coverage with ${staleAssets.length} stale assets needing attention.`,
      detail: 'Summarizes governance posture, current exposure, and the best next action to take now.',
      ctaLabel: 'Open Brief',
      tone: 'accent'
    },
    {
      id: 'ownership-load',
      title: 'Ownership Load',
      summary: `${ownerLoad[0]?.ownerName ?? 'Unassigned'} currently carries the heaviest metadata footprint.`,
      detail: 'Highlights stewardship concentration, unassigned assets, and health distribution by owner.',
      ctaLabel: 'View Owner Load',
      tone: 'neutral'
    },
    {
      id: 'remediation-pipeline',
      title: 'Remediation Pipeline',
      summary: `${tasks.length} tasks are active with ${duplicateAssets.length} duplicate assets still open.`,
      detail: 'Tracks open work, due dates, and the mix of remediation efforts underway.',
      ctaLabel: 'Review Pipeline',
      tone: 'danger'
    },
    {
      id: 'activity-digest',
      title: 'Activity Digest',
      summary: `${eventLogs.length} recent governance events are available for audit review and export.`,
      detail: 'Shows the latest execution trail so admins can trace important governance actions quickly.',
      ctaLabel: 'Open Digest',
      tone: 'accent'
    }
  ]
  const [activeReportId, setActiveReportId] = useState(reportDefinitions[0].id)
  const activeReport = reportDefinitions.find((report) => report.id === activeReportId) ?? reportDefinitions[0]

  function exportReport(reportId: string) {
    if (reportId === 'ownership-load') {
      downloadFile(
        'ownership-load-report.csv',
        toCsv(
          ownerLoad.map((row) => ({
            ownerName: row.ownerName,
            assetCount: String(row.assetCount),
            healthyCount: String(row.healthyCount),
            healthyRate: `${row.assetCount === 0 ? 0 : Math.round((row.healthyCount / row.assetCount) * 100)}%`
          }))
        ),
        'text/csv;charset=utf-8'
      )
      return
    }

    if (reportId === 'remediation-pipeline') {
      downloadFile(
        'remediation-pipeline.csv',
        toCsv(
          tasks.map((task) => ({
            title: task.title,
            ownerName: task.ownerName,
            priority: task.priority,
            status: task.status,
            dueDate: task.dueLabel,
            assetName: task.assetName ?? 'None'
          }))
        ),
        'text/csv;charset=utf-8'
      )
      return
    }

    if (reportId === 'activity-digest') {
      downloadFile(
        'activity-digest.csv',
        toCsv(
          eventLogs.map((eventLog) => ({
            title: eventLog.title,
            details: eventLog.details,
            timeLabel: eventLog.timeLabel,
            badge: eventLog.badge,
            tone: eventLog.tone
          }))
        ),
        'text/csv;charset=utf-8'
      )
      return
    }

    downloadFile(
      'executive-brief.csv',
      toCsv(
        highlights.map((highlight) => ({
          title: highlight.title,
          summary: highlight.text
        }))
      ),
      'text/csv;charset=utf-8'
    )
  }

  return (
    <>
      <section className="hero-row">
        <div>
          <div className="eyebrow">Operational Reporting</div>
          <h1>Governance Reports</h1>
          <p className="hero-copy">
            Generate admin-ready views for current posture, ownership concentration, remediation work, and recent activity.
          </p>
        </div>
        <div className="status-cluster">
          <span className="status-indicator ready">{reportDefinitions.length} live reports</span>
          <button className="primary-button" type="button" onClick={() => exportReport(activeReport.id)}>
            Export Current Report
          </button>
        </div>
      </section>

      <section className="reports-layout">
        <article className="panel report-catalog">
          <div className="panel-header">
            <div>
              <h2>Report Library</h2>
              <p className="chat-subheading">Click into a report to review it in-app, then export the current view when you need to share it.</p>
            </div>
          </div>
          <div className="report-list">
            {reportDefinitions.map((report) => (
              <button
                key={report.id}
                className={`report-card ${activeReportId === report.id ? 'active' : ''}`}
                type="button"
                onClick={() => setActiveReportId(report.id)}
              >
                <span className={`topic-topline ${report.tone}`}>{report.tone === 'danger' ? 'High Signal' : report.tone === 'accent' ? 'Executive' : 'Operational'}</span>
                <h3>{report.title}</h3>
                <p>{report.summary}</p>
                <strong>{report.ctaLabel}</strong>
              </button>
            ))}
          </div>
        </article>

        <article className="panel report-detail-panel">
          <div className="panel-header">
            <div>
              <h2>{activeReport.title}</h2>
              <p className="chat-subheading">{activeReport.detail}</p>
            </div>
            <div className="hero-actions">
              <button className="ghost-button" type="button" onClick={() => exportReport(activeReport.id)}>
                Export CSV
              </button>
              <button className="secondary-invert" type="button" onClick={() => window.print()}>
                Print / Save PDF
              </button>
            </div>
          </div>

          {activeReport.id === 'executive-brief' && (
            <div className="report-highlight-grid">
              {highlights.map((highlight) => (
                <article key={highlight.title} className="report-highlight-card">
                  <h3>{highlight.title}</h3>
                  <p>{highlight.text}</p>
                </article>
              ))}
            </div>
          )}

          {activeReport.id === 'ownership-load' && (
            <div className="report-data-list">
              {ownerLoad.map((owner) => (
                <div key={owner.ownerName} className="task-row">
                  <div>
                    <strong>{owner.ownerName}</strong>
                    <small>{owner.assetCount} assets assigned</small>
                  </div>
                  <span>{owner.assetCount === 0 ? 0 : Math.round((owner.healthyCount / owner.assetCount) * 100)}% healthy</span>
                </div>
              ))}
            </div>
          )}

          {activeReport.id === 'remediation-pipeline' && (
            <div className="report-data-list">
              {tasks.map((task) => (
                <div key={task.id} className="task-row">
                  <div>
                    <strong>{task.title}</strong>
                    <small>
                      {task.ownerName} · {task.taskType}
                    </small>
                  </div>
                  <span>
                    {task.status} · {task.dueLabel}
                  </span>
                </div>
              ))}
            </div>
          )}

          {activeReport.id === 'activity-digest' && (
            <div className="report-data-list">
              {eventLogs.map((eventLog) => (
                <div key={eventLog.id} className="log-item">
                  <div className={`activity-badge ${eventLog.tone}`}>
                    <span>{eventLog.badge.slice(0, 1)}</span>
                  </div>
                  <div className="activity-copy">
                    <strong>{eventLog.title}</strong>
                    <p>{eventLog.details}</p>
                  </div>
                  <div className="activity-meta">
                    <span>{eventLog.timeLabel}</span>
                    <span className={`tag ${eventLog.tone}`}>{eventLog.badge}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </article>
      </section>
    </>
  )
}

function TasksPage({ tasks, onAddTask }: { tasks: GovernanceTask[]; onAddTask: () => void }) {
  return (
    <>
      <section className="hero-row">
        <div>
          <div className="eyebrow">Stewardship Queue</div>
          <h1>Tasks</h1>
          <p className="hero-copy">
            A queue of governance follow-ups that the app or the agent can tee up for an admin, steward, or review board.
          </p>
        </div>
        <div className="hero-actions">
          <button className="primary-button" type="button" onClick={onAddTask}>
            Add Task
          </button>
        </div>
      </section>
      <article className="panel">
        <div className="task-list">
          {tasks.map((task) => (
            <div key={task.id} className="task-row">
              <div>
                <strong>{task.title}</strong>
                <small>{task.ownerName}</small>
              </div>
              <span>{task.dueLabel}</span>
              <mark className={`tag ${task.priority === 'Critical' ? 'danger' : 'accent'}`}>{task.priority}</mark>
            </div>
          ))}
        </div>
      </article>
    </>
  )
}

function ModalShell({
  title,
  subtitle,
  onClose,
  children
}: {
  title: string
  subtitle: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="eyebrow">Action Center</div>
            <h3>{title}</h3>
            <p className="modal-copy">{subtitle}</p>
          </div>
          <button className="icon-button" type="button" aria-label="Close dialog" onClick={onClose}>
            {closeIcon}
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function MetricCard({ card, compact = false }: { card: StatCard; compact?: boolean }) {
  return (
    <article className={`panel metric-card ${compact ? 'compact' : ''}`}>
      <div className="metric-topline">
        <span className={`metric-icon ${card.tone}`}>{shieldIcon}</span>
        <span className={`metric-trend ${card.tone}`}>{card.trend}</span>
      </div>
      <div className="metric-label">{card.label}</div>
      <div className="metric-value">{card.value}</div>
      <p className="metric-helper">{card.helper}</p>
      {!compact && (
        <div className="progress-track">
          <div
            className="progress-fill"
            style={{
              width:
                card.label === 'Ownership Coverage'
                  ? card.value
                  : card.label === 'Stale Metadata'
                    ? `${Math.min(100, Number(card.value.replace(/,/g, '')) * 8)}%`
                    : `${Math.min(100, Number(card.value.replace(/,/g, '')) * 14)}%`
            }}
          />
        </div>
      )}
    </article>
  )
}

function HealthChart() {
  const values = [32, 34, 28, 40, 57, 36, 61, 82, 68]
  const points = values
    .map((value, index) => {
      const x = 24 + index * 54
      const y = 180 - value * 1.5
      return `${x},${y}`
    })
    .join(' ')

  return (
    <div className="chart-wrap">
      <svg viewBox="0 0 500 220" role="img" aria-label="Metadata health trend">
        <defs>
          <linearGradient id="chartFill" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="rgba(89, 101, 133, 0.25)" />
            <stop offset="100%" stopColor="rgba(89, 101, 133, 0)" />
          </linearGradient>
        </defs>
        {[40, 90, 140, 190].map((y) => (
          <line key={y} x1="20" y1={y} x2="480" y2={y} className="chart-grid-line" />
        ))}
        <polyline points={points} className="chart-line" />
        <polyline points={`24,190 ${points} 456,190`} className="chart-area" />
      </svg>
      <div className="chart-axis">
        <span>Day 01</span>
        <span>Day 15</span>
        <span>Today</span>
      </div>
    </div>
  )
}

function activityIcon(tone: GovernanceEventLog['tone']) {
  if (tone === 'danger') {
    return alertIcon
  }

  if (tone === 'accent') {
    return refreshIcon
  }

  return userPlusIcon
}

function iconForPage(page: PageKey) {
  switch (page) {
    case 'dashboard':
      return gridIcon
    case 'explorer':
      return searchIcon
    case 'reports':
      return chartIcon
    case 'agent':
      return sparkIcon
    case 'tasks':
      return clipboardIcon
    default:
      return gridIcon
  }
}

function statusTone(status: GovernanceAsset['status']) {
  if (status === 'Stale') {
    return 'danger'
  }

  if (status === 'Duplicate' || status === 'NeedsReview') {
    return 'accent'
  }

  return 'healthy'
}

function toneToTag(tone: GovernanceEventLog['tone']) {
  if (tone === 'danger') {
    return 'danger'
  }

  if (tone === 'accent') {
    return 'accent'
  }

  return 'neutral'
}

function getInitials(value: string) {
  return value
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}

function toCsv(rows: Array<Record<string, string>>) {
  if (rows.length === 0) {
    return 'Name,ApiName,Id,Type,Department,Owner,Status,HealthScore\n'
  }

  const headers = Object.keys(rows[0])
  const csvRows = [headers.join(',')]

  rows.forEach((row) => {
    csvRows.push(headers.map((header) => escapeCsv(row[header] ?? '')).join(','))
  })

  return csvRows.join('\n')
}

function escapeCsv(value: string) {
  const escaped = value.replace(/"/g, '""')
  return /[",\n]/.test(value) ? `"${escaped}"` : escaped
}

function downloadFile(fileName: string, content: string, contentType: string) {
  const blob = new Blob([content], { type: contentType })
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  window.setTimeout(() => window.URL.revokeObjectURL(url), 0)
}

function buildPrintableTable(assets: GovernanceAsset[]) {
  const rows = assets
    .map(
      (asset) => `
        <tr>
          <td>${asset.name}</td>
          <td>${asset.apiName}</td>
          <td>${asset.id}</td>
          <td>${asset.type}</td>
          <td>${asset.department}</td>
          <td>${asset.ownerName ?? 'Unassigned'}</td>
          <td>${asset.status}</td>
          <td>${asset.healthScore}</td>
        </tr>
      `
    )
    .join('')

  return `
    <html>
      <head>
        <title>Data Curator Export</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 24px; color: #28313d; }
          h1 { margin-bottom: 8px; }
          p { color: #66758c; margin-top: 0; }
          table { width: 100%; border-collapse: collapse; margin-top: 20px; }
          th, td { border: 1px solid #dfe5ef; padding: 10px; text-align: left; }
          th { background: #f3f6fb; text-transform: uppercase; font-size: 12px; letter-spacing: 0.08em; }
        </style>
      </head>
      <body>
        <h1>Data Curator Explorer Export</h1>
        <p>Generated ${new Date().toLocaleString()}</p>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>API Name</th>
              <th>ID</th>
              <th>Type</th>
              <th>Department</th>
              <th>Owner</th>
              <th>Status</th>
              <th>Health Score</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </body>
    </html>
  `
}

const searchIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="11" cy="11" r="6" />
    <path d="M20 20 16.5 16.5" />
  </svg>
)

const gridIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="4" y="4" width="6" height="6" />
    <rect x="14" y="4" width="6" height="6" />
    <rect x="4" y="14" width="6" height="6" />
    <rect x="14" y="14" width="6" height="6" />
  </svg>
)

const chartIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 19V5" />
    <path d="M4 19H20" />
    <rect x="7" y="11" width="3" height="5" />
    <rect x="12" y="8" width="3" height="8" />
    <rect x="17" y="6" width="3" height="10" />
  </svg>
)

const sparkIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3 14.5 8.5 20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5L12 3Z" />
  </svg>
)

const clipboardIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="6" y="5" width="12" height="15" rx="2" />
    <path d="M9 5.5h6V4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v1.5Z" />
  </svg>
)

const bellIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 17h12" />
    <path d="M8 17V11a4 4 0 1 1 8 0v6" />
    <path d="M10 20a2 2 0 0 0 4 0" />
  </svg>
)

const shieldIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3 18 5v6c0 4-2.7 7.3-6 8-3.3-.7-6-4-6-8V5l6-2Z" />
  </svg>
)

const refreshIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 12a8 8 0 0 1 13.7-5.7L20 8" />
    <path d="M20 12a8 8 0 0 1-13.7 5.7L4 16" />
    <path d="M20 8h-4" />
    <path d="M4 16h4" />
  </svg>
)

const userPlusIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="9" cy="8" r="3" />
    <path d="M4 19a5 5 0 0 1 10 0" />
    <path d="M18 8v6" />
    <path d="M15 11h6" />
  </svg>
)

const alertIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 4 20 19H4L12 4Z" />
    <path d="M12 9v4" />
    <circle cx="12" cy="16.5" r="0.75" fill="currentColor" stroke="none" />
  </svg>
)

const closeIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="m6 6 12 12" />
    <path d="M18 6 6 18" />
  </svg>
)

export default App
