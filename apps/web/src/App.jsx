import {
  useCallback,
  useEffect,
  useState,
} from 'react';
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { COMMUNICATION_CATEGORY } from '@pv/shared';
import { api, pollJob } from './api.js';
import { installedSnap, installSnap, invokeSnap, syncSnapInbox } from './snap.js';
import { useWallet } from './wallet.jsx';
import {
  EmptyState,
  EventCard,
  Loading,
  Notice,
  StatusPill,
  formatAmount,
  formatDate,
  shortAddress,
} from './ui.jsx';

const navItems = [
  ['/', '⌂', 'Overview'],
  ['/ongoing', '◉', 'Ongoing events'],
  ['/explore', '◇', 'Explore events'],
  ['/create', '+', 'Create event'],
  ['/my-events', '▤', 'My events'],
  ['/completed', '✓', 'Completed'],
  ['/communications', '✦', 'Wallet inbox'],
];

function pageName(pathname) {
  if (pathname.startsWith('/create')) return 'Create proxy-voting event';
  if (pathname.startsWith('/my-events')) return 'Creator workspace';
  if (pathname.startsWith('/ongoing')) return 'Eligible ongoing events';
  if (pathname.startsWith('/completed')) return 'Completed events';
  if (pathname.startsWith('/communications')) return 'Investor communications';
  if (pathname.startsWith('/explore')) return 'Explore public events';
  if (pathname.includes('/vote')) return 'Voting dashboard';
  if (pathname.includes('/results')) return 'Event results';
  if (pathname.includes('/manage')) return 'Event management';
  if (pathname.startsWith('/events/')) return 'Event details';
  return 'On-chain proxy voting V2';
}


function DappSnapBridge() {
  const wallet = useWallet();

  useEffect(() => {
    if (!wallet.account || !wallet.authenticated) return undefined;
    let active = true;
    const sync = async () => {
      try {
        if (!(await installedSnap()) || !active) return;
        await syncSnapInbox({
          walletAddress: wallet.account,
          ensureAuthenticated: wallet.ensureAuthenticated,
          install: false,
        });
      } catch {
        // Communications must never interrupt voting or navigation.
      }
    };
    sync();
    const timer = setInterval(sync, 60_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [wallet.account, wallet.authenticated, wallet.ensureAuthenticated]);

  return null;
}

function Shell({ children }) {
  const location = useLocation();
  const wallet = useWallet();
  const [error, setError] = useState('');

  const connect = async () => {
    setError('');
    try {
      await wallet.connect();
    } catch (caught) {
      setError(caught.message);
    }
  };


  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <span className="sidebar-eyebrow">Broadridge proof of concept</span>
          <span className="sidebar-title">Proxy Voting V2</span>
        </div>
        <nav className="sidebar-nav">
          {navItems.map(([to, icon, label]) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
            >
              <span className="nav-icon">{icon}</span>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <img className="sidebar-logo" src="/broadridge-logo-white.png" alt="Broadridge" />
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div className="topbar-title">
            <span className="topbar-eyebrow">Polygon Amoy · one contract per event</span>
            <strong>{pageName(location.pathname)}</strong>
          </div>
          <div className="topbar-actions">
            <button className="wallet-button" type="button" onClick={connect} disabled={wallet.busy}>
              <span className={`wallet-dot${wallet.connected ? ' connected' : ''}`} />
              {wallet.connected ? shortAddress(wallet.account) : wallet.busy ? 'Connecting…' : 'Connect MetaMask'}
            </button>
          </div>
        </header>
        {error && <div className="global-error">{error}</div>}
        <div className="page-scroll">
          <div className="page-content">{children}</div>
        </div>
        <DappSnapBridge />
      </main>
    </div>
  );
}

function PageHeader({ eyebrow, title, body, actions }) {
  return (
    <header className="page-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {body && <p>{body}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

function useRemote(loader, dependencies = [], { enabled = true, interval = 0 } = {}) {
  const [state, setState] = useState({ loading: enabled, value: null, error: '' });
  const refresh = useCallback(async () => {
    if (!enabled) {
      setState({ loading: false, value: null, error: '' });
      return null;
    }
    setState((previous) => ({ ...previous, loading: previous.value === null, error: '' }));
    try {
      const value = await loader();
      setState({ loading: false, value, error: '' });
      return value;
    } catch (error) {
      setState((previous) => ({ ...previous, loading: false, error: error.message }));
      return null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...dependencies]);

  useEffect(() => {
    let active = true;
    const run = async () => {
      if (active) await refresh();
    };
    run();
    if (!interval || !enabled) return () => { active = false; };
    const timer = setInterval(run, interval);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [enabled, interval, refresh]);

  return { ...state, refresh };
}

function HomePage() {
  return (
    <>
      <section className="hero-card">
        <div>
          <span className="eyebrow light">Mini Galaxy · proxy voting V2</span>
          <h1>Lightweight proxy voting for any standard ERC-20 token.</h1>
          <p>
            One immutable VoteEvent contract per event, record-date Merkle snapshots,
            Neon-indexed discovery, relayer-funded voting, and verified MetaMask
            communications delivered through the dApp.
          </p>
          <div className="hero-actions">
            <Link className="button primary large" to="/create">Create an event</Link>
            <Link className="button ghost-light large" to="/ongoing">View eligible events</Link>
          </div>
        </div>
        <div className="architecture-mini" aria-label="Architecture">
          <span>Vercel dApp</span><b>↓</b>
          <span>Render API + worker</span><b>↓</b>
          <span>Neon + Polygon Amoy</span><b>↓</b>
          <span>MetaMask Snap</span>
        </div>
      </section>
      <div className="health-strip">
        <span><i />V2 architecture</span>
        <span>No role personas</span>
        <span>No DeploymentRegistry</span>
        <span>No runtime compilation</span>
        <span>One final ballot</span>
      </div>
      <section className="feature-grid">
        <article><span className="feature-number">01</span><h3>Prepare</h3><p>Creator supplies the token, proposals, past/present record date, voting window, and natural-number ratio.</p></article>
        <article><span className="feature-number">02</span><h3>Snapshot</h3><p>The Render worker reconstructs standard ERC-20 balances and commits eligible holders into a Merkle root.</p></article>
        <article><span className="feature-number">03</span><h3>Deploy</h3><p>The relayer deploys exactly one compact VoteEvent contract and pays the small Amoy POL fee.</p></article>
        <article><span className="feature-number">04</span><h3>Vote</h3><p>Eligible wallets sign one final ballot; the relayer submits it and the contract updates authoritative tallies.</p></article>
      </section>
      <section className="notice-card">
        <div>
          <h3>Record-date discovery is indexed, not trusted.</h3>
          <p>Neon makes lookups fast, while the VoteEvent Merkle root and on-chain tally remain authoritative.</p>
        </div>
        <Link className="button secondary" to="/explore">Explore public events</Link>
      </section>
    </>
  );
}

function ConnectState({ body }) {
  const wallet = useWallet();
  return (
    <EmptyState
      title="Connect MetaMask"
      body={body}
      action={<button className="button primary" type="button" onClick={() => wallet.connect()} disabled={wallet.busy}>Connect wallet</button>}
    />
  );
}

function OngoingPage() {
  const wallet = useWallet();
  const remote = useRemote(
    () => api(`/v1/wallets/${wallet.account}/events?scope=ongoing`),
    [wallet.account],
    { enabled: Boolean(wallet.account), interval: 12_000 },
  );
  if (!wallet.account) return <ConnectState body="Connect the wallet whose record-date eligibility you want to discover." />;
  if (remote.loading) return <Loading label="Finding eligible events…" />;
  return (
    <>
      <PageHeader
        eyebrow="Investor portal"
        title="Ongoing events you can participate in"
        body="Eligibility comes from the record-date snapshot, not the wallet's current token balance. Open events route directly to the voting dashboard."
        actions={<button className="button secondary" type="button" onClick={remote.refresh}>Refresh</button>}
      />
      {remote.error && <Notice tone="danger">{remote.error}</Notice>}
      {!remote.value?.length ? (
        <EmptyState title="No eligible ongoing events" body="This wallet is not currently included in any discoverable record-date snapshot." />
      ) : (
        <div className="event-grid">
          {remote.value.map((event) => <EventCard key={event.id} event={event} showEligibility directToVote />)}
        </div>
      )}
    </>
  );
}

function ExplorePage() {
  const remote = useRemote(() => api('/v1/events?scope=ongoing'), [], { interval: 15_000 });
  if (remote.loading) return <Loading label="Loading public events…" />;
  return (
    <>
      <PageHeader
        eyebrow="Public discovery"
        title="Explore creator-published events"
        body="Public discovery does not itself prove issuer authorization. Check the authenticity label and contract details before acting."
        actions={<Link className="button primary" to="/create">Create event</Link>}
      />
      {remote.error && <Notice tone="danger">{remote.error}</Notice>}
      {!remote.value?.length ? (
        <EmptyState title="No public ongoing events" body="A creator can choose public, subscriber-only, or direct-link discovery." />
      ) : (
        <div className="event-grid">{remote.value.map((event) => <EventCard key={event.id} event={event} />)}</div>
      )}
    </>
  );
}

function CompletedPage() {
  const wallet = useWallet();
  const endpoint = wallet.account
    ? `/v1/wallets/${wallet.account}/events?scope=completed`
    : '/v1/events?scope=completed';
  const remote = useRemote(() => api(endpoint), [endpoint], { interval: 30_000 });
  if (remote.loading) return <Loading label="Loading completed events…" />;
  return (
    <>
      <PageHeader
        eyebrow="Results"
        title={wallet.account ? 'Completed events for this wallet' : 'Completed public events'}
        body="Results are read from each event's VoteEvent contract after the voting deadline."
      />
      {remote.error && <Notice tone="danger">{remote.error}</Notice>}
      {!remote.value?.length ? (
        <EmptyState title="No completed events" body="Completed results will appear here after a voting window closes." />
      ) : (
        <div className="event-grid">{remote.value.map((event) => <EventCard key={event.id} event={event} showEligibility={Boolean(wallet.account)} />)}</div>
      )}
    </>
  );
}

function defaultDateTime(offsetMinutes = 0) {
  const date = new Date(Date.now() + offsetMinutes * 60_000);
  date.setSeconds(0, 0);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function emptyProposal() {
  return {
    title: '',
    description: '',
    options: ['For', 'Against', 'Abstain'],
    recommendation: 0,
  };
}

function CreatePage() {
  const wallet = useWallet();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    tokenAddress: '',
    title: '',
    description: '',
    recordDateAt: defaultDateTime(-5),
    votingStartAt: defaultDateTime(5),
    votingEndAt: defaultDateTime(24 * 60),
    tokenToVoteRatio: 1,
    authenticityClaim: 'COMMUNITY',
    discoveryMode: 'PUBLIC_ELIGIBLE',
    snapDeliveryMode: 'ELIGIBLE',
    proposals: [emptyProposal()],
  });
  const [token, setToken] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const update = (field, value) => setForm((previous) => ({ ...previous, [field]: value }));
  const updateProposal = (proposalIndex, patch) => {
    setForm((previous) => ({
      ...previous,
      proposals: previous.proposals.map((proposal, index) => (
        index === proposalIndex ? { ...proposal, ...patch } : proposal
      )),
    }));
  };
  const updateOption = (proposalIndex, optionIndex, value) => {
    const proposal = form.proposals[proposalIndex];
    updateProposal(proposalIndex, {
      options: proposal.options.map((option, index) => (index === optionIndex ? value : option)),
    });
  };

  const inspect = async () => {
    setError('');
    setBusy('inspect');
    try {
      const value = await api('/v1/tokens/inspect', { method: 'POST', body: { tokenAddress: form.tokenAddress } });
      setToken(value);
    } catch (caught) {
      setToken(null);
      setError(caught.message);
    } finally {
      setBusy('');
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setBusy('submit');
    try {
      await wallet.ensureAuthenticated();
      const created = await api('/v1/events', {
        method: 'POST',
        body: {
          ...form,
          tokenToVoteRatio: Number(form.tokenToVoteRatio),
          recordDateAt: new Date(form.recordDateAt).toISOString(),
          votingStartAt: new Date(form.votingStartAt).toISOString(),
          votingEndAt: new Date(form.votingEndAt).toISOString(),
        },
      });
      navigate(`/events/${created.id}/manage`);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy('');
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Permissionless creator"
        title="Create a proxy-voting event"
        body="The connected wallet prepares proposals. The Render worker builds the record-date snapshot, then automatically spends relayer POL to deploy exactly one VoteEvent contract."
      />
      {!wallet.account && <Notice>Connecting and signing a login challenge is required before creation. It does not cost gas.</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
      <form className="form-stack" onSubmit={submit}>
        <section className="content-card">
          <div className="section-heading"><span>1</span><div><h2>ERC-20 asset</h2><p>Standard Transfer-indexable ERC-20 tokens on Polygon Amoy only.</p></div></div>
          <div className="field-row">
            <label className="field grow"><span>Token contract address</span><input value={form.tokenAddress} onChange={(event) => { update('tokenAddress', event.target.value); setToken(null); }} placeholder="0x…" required /></label>
            <button className="button secondary field-button" type="button" onClick={inspect} disabled={busy === 'inspect' || !form.tokenAddress}>{busy === 'inspect' ? 'Inspecting…' : 'Inspect token'}</button>
          </div>
          {token && (
            <div className="token-confirm"><strong>✓ {token.name} ({token.symbol})</strong><span>{token.decimals} decimals</span><code>{token.tokenAddress}</code></div>
          )}
        </section>

        <section className="content-card">
          <div className="section-heading"><span>2</span><div><h2>Event configuration</h2><p>Record date must be now or in the past. Voting power uses whole token units divided by X.</p></div></div>
          <div className="form-grid two">
            <label className="field"><span>Event title</span><input value={form.title} onChange={(event) => update('title', event.target.value)} maxLength={180} required /></label>
            <label className="field"><span>Token-to-vote ratio (X)</span><input type="number" min="1" step="1" value={form.tokenToVoteRatio} onChange={(event) => update('tokenToVoteRatio', event.target.value)} required /><small>Voting power = floor(whole token balance ÷ X).</small></label>
          </div>
          <label className="field"><span>Description</span><textarea rows="4" value={form.description} onChange={(event) => update('description', event.target.value)} maxLength={8000} /></label>
          <div className="form-grid three">
            <label className="field"><span>Record date and time</span><input type="datetime-local" max={defaultDateTime(0)} value={form.recordDateAt} onChange={(event) => update('recordDateAt', event.target.value)} required /></label>
            <label className="field"><span>Voting starts</span><input type="datetime-local" value={form.votingStartAt} onChange={(event) => update('votingStartAt', event.target.value)} required /></label>
            <label className="field"><span>Voting ends</span><input type="datetime-local" value={form.votingEndAt} onChange={(event) => update('votingEndAt', event.target.value)} required /></label>
          </div>
          <div className="form-grid three">
            <label className="field"><span>Authenticity claim</span><select value={form.authenticityClaim} onChange={(event) => update('authenticityClaim', event.target.value)}><option value="COMMUNITY">Community-created</option><option value="ISSUER_AUTHORIZED">Issuer-authorized claim</option></select><small>If owner() exists and matches, the API upgrades the label automatically.</small></label>
            <label className="field"><span>Discovery</span><select value={form.discoveryMode} onChange={(event) => update('discoveryMode', event.target.value)}><option value="PUBLIC_ELIGIBLE">Public to eligible wallets</option><option value="SUBSCRIBERS_ONLY">Subscribers only</option><option value="DIRECT_LINK">Direct link only</option></select></label>
            <label className="field"><span>Snap delivery</span><select value={form.snapDeliveryMode} onChange={(event) => update('snapDeliveryMode', event.target.value)}><option value="ELIGIBLE">All eligible holders</option><option value="SUBSCRIBERS_ONLY">Subscribed investors only</option><option value="DISABLED">Disabled</option></select></label>
          </div>
        </section>

        <section className="content-card">
          <div className="section-heading"><span>3</span><div><h2>Proposals and ballot options</h2><p>Proposal text stays in Neon and is cryptographically committed by one metadata hash in the contract.</p></div></div>
          <div className="proposal-editor-list">
            {form.proposals.map((proposal, proposalIndex) => (
              <div className="proposal-editor" key={`proposal-${proposalIndex}`}>
                <div className="proposal-editor-head"><h3>Proposal {proposalIndex + 1}</h3>{form.proposals.length > 1 && <button className="text-button danger" type="button" onClick={() => update('proposals', form.proposals.filter((_, index) => index !== proposalIndex))}>Remove proposal</button>}</div>
                <div className="form-grid two">
                  <label className="field"><span>Proposal title</span><input value={proposal.title} onChange={(event) => updateProposal(proposalIndex, { title: event.target.value })} required /></label>
                  <label className="field"><span>Creator recommendation</span><select value={proposal.recommendation ?? ''} onChange={(event) => updateProposal(proposalIndex, { recommendation: event.target.value === '' ? null : Number(event.target.value) })}><option value="">No recommendation</option>{proposal.options.map((option, optionIndex) => <option value={optionIndex} key={`recommend-${optionIndex}`}>{option || `Option ${optionIndex + 1}`}</option>)}</select></label>
                </div>
                <label className="field"><span>Proposal description</span><textarea rows="3" value={proposal.description} onChange={(event) => updateProposal(proposalIndex, { description: event.target.value })} /></label>
                <div className="options-editor">
                  {proposal.options.map((option, optionIndex) => (
                    <div className="option-edit" key={`option-${optionIndex}`}>
                      <input value={option} onChange={(event) => updateOption(proposalIndex, optionIndex, event.target.value)} placeholder={`Option ${optionIndex + 1}`} required />
                      <button type="button" aria-label="Remove option" disabled={proposal.options.length <= 2} onClick={() => updateProposal(proposalIndex, { options: proposal.options.filter((_, index) => index !== optionIndex), recommendation: null })}>×</button>
                    </div>
                  ))}
                </div>
                {proposal.options.length < 4 && <button className="text-button" type="button" onClick={() => updateProposal(proposalIndex, { options: [...proposal.options, ''] })}>+ Add option</button>}
              </div>
            ))}
          </div>
          {form.proposals.length < 32 && <button className="button secondary" type="button" onClick={() => update('proposals', [...form.proposals, emptyProposal()])}>+ Add proposal</button>}
        </section>

        <div className="form-submit">
          <p>Creation stores the event in Neon and queues the snapshot. A successful snapshot automatically queues the single sponsored VoteEvent deployment; no compiler runs inside the request.</p>
          <button className="button primary large" type="submit" disabled={busy === 'submit' || !token}>{busy === 'submit' ? 'Creating…' : 'Create and start snapshot'}</button>
        </div>
      </form>
    </>
  );
}

function MyEventsPage() {
  const wallet = useWallet();
  const remote = useRemote(() => api('/v1/events/created'), [wallet.account], { enabled: Boolean(wallet.account), interval: 8_000 });
  if (!wallet.account) return <ConnectState body="Connect the creator wallet to manage its events and communications." />;
  if (remote.loading) return <Loading label="Loading creator events…" />;
  return (
    <>
      <PageHeader eyebrow="Creator workspace" title="Events created by this wallet" body="Each event progresses independently through snapshot, one-contract deployment, voting, and results." actions={<Link className="button primary" to="/create">Create event</Link>} />
      {remote.error && <Notice tone="danger">{remote.error}</Notice>}
      {!remote.value?.length ? <EmptyState title="No creator events" body="Create the first V2 event for a standard ERC-20 token." action={<Link className="button primary" to="/create">Create event</Link>} /> : <div className="event-grid">{remote.value.map((event) => <EventCard key={event.id} event={event} />)}</div>}
    </>
  );
}

function EventFacts({ event, eligibility }) {
  return (
    <div className="facts-grid">
      <div><b>Creator</b><code>{shortAddress(event.creatorAddress, 8, 6)}</code></div>
      <div><b>Token</b><code>{shortAddress(event.tokenAddress, 8, 6)}</code></div>
      <div><b>Record date</b><span>{formatDate(event.recordDateAt)}</span></div>
      <div><b>Voting window</b><span>{formatDate(event.votingStartAt)} → {formatDate(event.votingEndAt)}</span></div>
      <div><b>Ratio</b><span>{event.tokenToVoteRatio} token(s) per vote</span></div>
      <div><b>Snapshot holders</b><span>{event.snapshotHolderCount ?? 'Pending'}</span></div>
      {eligibility && <div><b>Your record-date tokens</b><span>{formatAmount(eligibility.rawBalance, event.tokenDecimals)}</span></div>}
      {eligibility && <div><b>Your voting power</b><span>{eligibility.votingPower}</span></div>}
      <div><b>Discovery</b><span>{event.discoveryMode.replaceAll('_', ' ')}</span></div>
    </div>
  );
}

function ProposalPreview({ event }) {
  return (
    <div className="proposal-list">
      {event.metadata.proposals.map((proposal) => (
        <article key={proposal.index}>
          <div><span>{proposal.index + 1}</span><h3>{proposal.title}</h3></div>
          {proposal.description && <p>{proposal.description}</p>}
          <div className="option-tags">{proposal.options.map((option) => <span key={option.index}>{option.text}{proposal.recommendation === option.index ? ' · Recommended' : ''}</span>)}</div>
        </article>
      ))}
    </div>
  );
}

function EventPage() {
  const { eventId } = useParams();
  const wallet = useWallet();
  const eventRemote = useRemote(() => api(`/v1/events/${eventId}`), [eventId], { interval: 8_000 });
  const eligibilityRemote = useRemote(
    () => api(`/v1/events/${eventId}/eligibility/${wallet.account}`),
    [eventId, wallet.account],
    { enabled: Boolean(wallet.account), interval: 8_000 },
  );
  if (eventRemote.loading) return <Loading label="Loading event…" />;
  if (eventRemote.error) return <Notice tone="danger">{eventRemote.error}</Notice>;
  const event = eventRemote.value;
  const eligibility = eligibilityRemote.value;
  const creator = wallet.account === event.creatorAddress;
  const canVote = event.status === 'OPEN' && eligibility?.eligible && eligibility?.canVote && !eligibility?.hasVoted;
  const metadataMismatch = !event.metadataIntegrity || event.contractMetadataIntegrity === false;
  const metadataLabel = metadataMismatch
    ? 'Metadata mismatch'
    : event.contractMetadataIntegrity === true
      ? '✓ Neon metadata matches contract hash'
      : '✓ Canonical Neon metadata hash valid';
  return (
    <>
      <PageHeader
        eyebrow={`${event.tokenName} · ${event.tokenSymbol}`}
        title={event.title}
        body={event.description}
        actions={(
          <>
            <StatusPill status={event.status} />
            {creator && <Link className="button secondary" to={`/events/${event.id}/manage`}>Manage</Link>}
            {canVote && <Link className="button primary" to={`/events/${event.id}/vote`}>Open voting dashboard</Link>}
            {event.status === 'CLOSED' && event.contractAddress && <Link className="button primary" to={`/events/${event.id}/results`}>View results</Link>}
          </>
        )}
      />
      <section className="content-card">
        <div className="content-card-head"><div><h2>Event integrity</h2><p>Metadata is checked against the hash committed in the VoteEvent contract configuration.</p></div><span className={metadataMismatch ? 'integrity-bad' : 'integrity-ok'}>{metadataLabel}</span></div>
        <EventFacts event={event} eligibility={eligibility} />
      </section>
      {wallet.account && eligibility && !eligibility.eligible && <Notice tone="danger">This wallet was not eligible at the record-date snapshot.</Notice>}
      {eligibility?.hasVoted && <Notice tone="success">Your final ballot is already queued or recorded. <Link to={`/events/${event.id}/vote`}>Open receipt</Link></Notice>}
      <section className="content-card">
        <div className="content-card-head"><div><h2>Ballot proposals</h2><p>{event.metadata.proposals.length} proposal(s), immutable after metadata commitment.</p></div></div>
        <ProposalPreview event={event} />
      </section>
      <section className="content-card">
        <div className="content-card-head"><div><h2>On-chain publication</h2><p>The source verification process is independent from transaction confirmation.</p></div><StatusPill status={event.sourceVerificationStatus} /></div>
        <div className="link-list">
          {event.deploymentExplorerUrl ? <a href={event.deploymentExplorerUrl} target="_blank" rel="noreferrer">View deployment transaction ↗</a> : <span>Deployment transaction pending</span>}
          {event.contractExplorerUrl ? <a href={event.contractExplorerUrl} target="_blank" rel="noreferrer">View VoteEvent contract ↗</a> : <span>Contract address pending</span>}
        </div>
      </section>
    </>
  );
}

function receiptTitle(status) {
  if (status === 'CONFIRMED') return 'Vote successfully recorded';
  if (status === 'SUBMITTED') return 'Vote submitted to Polygon Amoy';
  if (status === 'FAILED') return 'Vote submission failed';
  return 'Vote queued for gasless submission';
}

function VoteReceipt({ event, vote, job, error, onRetry, retrying = false }) {
  const status = job?.status === 'FAILED' ? 'FAILED' : vote?.status ?? job?.status ?? 'QUEUED';
  const failed = status === 'FAILED' || job?.status === 'FAILED';
  return (
    <section className="content-card receipt-card">
      <div className="receipt-check">{failed ? '!' : status === 'CONFIRMED' ? '✓' : '…'}</div>
      <div>
        <StatusPill status={status} />
        <h1>{receiptTitle(status)}</h1>
        <p>{failed ? (vote?.failureMessage || job?.lastError || error) : job?.progressMessage || 'The Render relayer is processing your signed final ballot.'}</p>
      </div>
      <div className="receipt-grid">
        <span><b>Voting power</b><strong>{vote?.votingPower ?? '—'}</strong></span>
        <span><b>VoteEvent contract</b>{event.contractExplorerUrl ? <a href={event.contractExplorerUrl} target="_blank" rel="noreferrer">{shortAddress(event.contractAddress, 10, 8)} ↗</a> : 'Pending'}</span>
        <span><b>Transaction</b>{vote?.transactionExplorerUrl ? <a href={vote.transactionExplorerUrl} target="_blank" rel="noreferrer">{shortAddress(vote.transactionHash, 12, 8)} ↗</a> : 'Waiting for relayer broadcast'}</span>
        <span><b>Source verification</b>{event.sourceVerificationStatus.replaceAll('_', ' ')}</span>
      </div>
      {failed && <button className="button secondary align-start" type="button" disabled={retrying} onClick={onRetry}>{retrying ? 'Retrying…' : 'Retry existing signed ballot'}</button>}
    </section>
  );
}

function VotePage() {
  const { eventId } = useParams();
  const wallet = useWallet();
  const [event, setEvent] = useState(null);
  const [eligibility, setEligibility] = useState(null);
  const [choices, setChoices] = useState([]);
  const [vote, setVote] = useState(null);
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!wallet.account) return;
    const [nextEvent, nextEligibility, nextVote] = await Promise.all([
      api(`/v1/events/${eventId}`),
      api(`/v1/events/${eventId}/eligibility/${wallet.account}`),
      api(`/v1/events/${eventId}/votes/${wallet.account}`),
    ]);
    setEvent(nextEvent);
    setEligibility(nextEligibility);
    setVote(nextVote);
    setChoices((previous) => previous.length ? previous : Array(nextEvent.metadata.proposals.length).fill(null));
  }, [eventId, wallet.account]);

  useEffect(() => {
    let active = true;

    // Wallet and event state are deliberately isolated. Never show the previous
    // wallet's receipt or ballot while the new wallet-specific reads are loading.
    setEvent(null);
    setEligibility(null);
    setChoices([]);
    setVote(null);
    setJob(null);
    setError('');

    if (!wallet.account) {
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    refresh()
      .catch((caught) => active && setError(caught.message))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [refresh, wallet.account]);

  useEffect(() => {
    if (!wallet.account || !vote || ['CONFIRMED', 'FAILED'].includes(vote.status)) return undefined;
    const timer = setInterval(() => {
      Promise.all([
        api(`/v1/events/${eventId}/votes/${wallet.account}`),
        job?.id ? api(`/v1/jobs/${job.id}`) : Promise.resolve(null),
      ]).then(([nextVote, nextJob]) => {
        if (nextVote) setVote(nextVote);
        if (nextJob) setJob(nextJob);
      }).catch(() => {});
    }, 1200);
    return () => clearInterval(timer);
  }, [eventId, job?.id, vote, wallet.account]);

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      await wallet.ensureAuthenticated();
      const prepared = await api(`/v1/events/${eventId}/ballot`, { method: 'POST', body: { choices } });
      const signer = await wallet.getSigner();
      const signature = await signer.signTypedData(
        prepared.typedData.domain,
        prepared.typedData.types,
        prepared.typedData.message,
      );
      const queued = await api(`/v1/events/${eventId}/votes`, {
        method: 'POST',
        body: { choices, signature },
      });
      setVote(queued.vote);
      setJob(queued.job);
      pollJob(queued.job.id, {
        onUpdate: setJob,
        timeout: 180_000,
        interval: 1000,
      }).catch((caught) => setError(caught.message)).finally(() => refresh().catch(() => {}));
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  };

  const retryExisting = async () => {
    setError('');
    setBusy(true);
    try {
      await wallet.ensureAuthenticated();
      const retried = await api(`/v1/events/${eventId}/votes/retry`, { method: 'POST' });
      setVote(retried.vote);
      setJob(retried.job);
      pollJob(retried.job.id, {
        onUpdate: setJob,
        timeout: 180_000,
        interval: 1000,
      }).catch((caught) => setError(caught.message)).finally(() => refresh().catch(() => {}));
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  };

  if (!wallet.account) return <ConnectState body="Connect the eligible wallet to open its voting dashboard." />;
  if (loading || !event || !eligibility) return <Loading label="Preparing voting dashboard…" />;
  const displayedVote = vote ?? eligibility.vote;
  const hasReceipt = eligibility.hasVoted || Boolean(displayedVote);
  if (hasReceipt) {
    return (
      <>
        <PageHeader eyebrow={event.tokenSymbol} title={event.title} body="Your final ballot status and immutable on-chain references." actions={<Link className="button secondary" to={`/events/${event.id}`}>Event details</Link>} />
        <VoteReceipt event={event} vote={displayedVote ?? (eligibility.hasVoted ? { status: 'CONFIRMED', votingPower: eligibility.votingPower } : null)} job={job} error={error} onRetry={retryExisting} retrying={busy} />
      </>
    );
  }
  if (!eligibility.eligible || !eligibility.canVote) return <Notice tone="danger">This wallet has no voting power in the event's record-date snapshot.</Notice>;
  if (!event.metadataIntegrity || event.contractMetadataIntegrity !== true) {
    return <Notice tone="danger">Voting is blocked because the proposal metadata could not be verified against the deployed VoteEvent contract.</Notice>;
  }
  if (event.status !== 'OPEN') return <Notice>This event is currently {event.status.toLowerCase().replaceAll('_', ' ')}. Voting is available only during the configured window.</Notice>;
  const complete = choices.every((choice) => Number.isInteger(choice));

  return (
    <>
      <PageHeader eyebrow={`${event.tokenName} · final ballot`} title={event.title} body={`Record-date voting power: ${eligibility.votingPower}. One signed ballot is final and cannot be updated or recalled.`} />
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="ballot-list">
        {event.metadata.proposals.map((proposal, proposalIndex) => (
          <article className="ballot-card" key={proposal.index}>
            <div className="ballot-number">{proposalIndex + 1}</div>
            <div className="ballot-body">
              <h2>{proposal.title}</h2>
              {proposal.description && <p>{proposal.description}</p>}
              <div className="ballot-options">
                {proposal.options.map((option) => (
                  <label className={choices[proposalIndex] === option.index ? 'selected' : ''} key={option.index}>
                    <input
                      type="radio"
                      name={`proposal-${proposalIndex}`}
                      checked={choices[proposalIndex] === option.index}
                      onChange={() => setChoices((previous) => previous.map((choice, index) => index === proposalIndex ? option.index : choice))}
                    />
                    <span>{option.text}{proposal.recommendation === option.index && <small>Creator recommendation</small>}</span>
                  </label>
                ))}
              </div>
            </div>
          </article>
        ))}
      </div>
      <div className="submit-bar">
        <div><strong>{complete ? 'Ballot ready to sign' : 'Complete every proposal'}</strong><span>The relayer pays POL after your EIP-712 signature.</span></div>
        <button className="button primary large" type="button" disabled={!complete || busy} onClick={submit}>{busy ? 'Signing…' : 'Sign and submit final vote'}</button>
      </div>
    </>
  );
}

function jobStage(event) {
  const stages = ['SNAPSHOT_PENDING', 'SNAPSHOT_RUNNING', 'SNAPSHOT_READY', 'DEPLOYMENT_QUEUED', 'DEPLOYING', 'SCHEDULED', 'OPEN', 'CLOSED'];
  const index = stages.indexOf(event.status);
  return { stages, index: index < 0 ? 0 : index };
}

function ManagePage() {
  const { eventId } = useParams();
  const wallet = useWallet();
  const [event, setEvent] = useState(null);
  const [communications, setCommunications] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState({
    category: 'EVENT_ANNOUNCEMENT',
    audience: 'ALL_ELIGIBLE',
    title: '',
    body: '',
    publishedAt: defaultDateTime(0),
    expiresAt: defaultDateTime(7 * 24 * 60),
  });

  const refresh = useCallback(async () => {
    const next = await api(`/v1/events/${eventId}`);
    setEvent(next);
    if (wallet.account === next.creatorAddress && next.deploymentBlock !== null) {
      setCommunications(await api(`/v1/events/${eventId}/communications`));
    }
    return next;
  }, [eventId, wallet.account]);

useEffect(() => {
  let active = true;
  let requestInProgress = false;

  const runRefresh = async () => {
    if (!active || requestInProgress) return;

    requestInProgress = true;

    try {
      await refresh();
    } catch (caught) {
      if (active) {
        setError(caught.message);
      }
    } finally {
      requestInProgress = false;
    }
  };

  runRefresh();

  const timer = setInterval(runRefresh, 10_000);

  return () => {
    active = false;
    clearInterval(timer);
  };
}, [refresh]);

  const retrySnapshot = async () => {
    setBusy('snapshot');
    setError('');
    try {
      await wallet.ensureAuthenticated();
      await api(`/v1/events/${eventId}/retry-snapshot`, { method: 'POST' });
      await refresh();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy('');
    }
  };

  const retryDeployment = async () => {
    setBusy('deployment');
    setError('');
    try {
      await wallet.ensureAuthenticated();
      await api(`/v1/events/${eventId}/retry-deployment`, { method: 'POST' });
      await refresh();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy('');
    }
  };

  const publish = async (submitEvent) => {
    submitEvent.preventDefault();
    setBusy('communication');
    setError('');
    try {
      await wallet.ensureAuthenticated();
      const actionUrl = `${window.location.origin}/events/${eventId}`;
      const draft = {
        ...message,
        audience: event.snapDeliveryMode === 'SUBSCRIBERS_ONLY' ? 'SUBSCRIBERS' : message.audience,
        actionUrl,
        publishedAt: new Date(message.publishedAt).toISOString(),
        expiresAt: new Date(message.expiresAt).toISOString(),
      };
      const prepared = await api(`/v1/events/${eventId}/communications/payload`, { method: 'POST', body: draft });
      const signer = await wallet.getSigner();
      const signature = await signer.signMessage(prepared.signingMessage);
      await api(`/v1/events/${eventId}/communications`, {
        method: 'POST',
        body: { message: { ...draft, messageId: prepared.message.messageId }, signature },
      });
      setMessage((previous) => ({ ...previous, title: '', body: '' }));
      await refresh();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy('');
    }
  };

  if (!wallet.account) return <ConnectState body="Connect the event creator wallet to manage deployment and communications." />;
  if (!event) return error ? <Notice tone="danger">{error}</Notice> : <Loading label="Loading creator workspace…" />;
  if (wallet.account !== event.creatorAddress) return <Notice tone="danger">Only the event creator wallet can access this management page.</Notice>;
  const stage = jobStage(event);
  return (
    <>
      <PageHeader eyebrow="Creator workspace" title={event.title} body="Snapshot preparation, automatic relayer-funded one-contract deployment, source verification, and creator communications." actions={<Link className="button secondary" to={`/events/${event.id}`}>View public page</Link>} />
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="form-grid two">
        <section className="content-card timeline-card">
          {stage.stages.map((name, index) => (
            <div className={`timeline-step${index < stage.index ? ' done' : index === stage.index ? ' active' : ''}`} key={name}>
              <b>{index < stage.index ? '✓' : index + 1}</b>
              <div><strong>{name.replaceAll('_', ' ')}</strong><span>{index === stage.index ? event.latestJob?.progressMessage || 'Current stage' : index < stage.index ? 'Completed' : 'Pending'}</span></div>
            </div>
          ))}
        </section>
        <section className="content-card">
          <div className="content-card-head"><div><h2>Deployment status</h2><p>Each stage runs independently in the Render worker.</p></div><StatusPill status={event.status} /></div>
          {event.latestJob && (
            <div className="job-list">
              <div><StatusPill status={event.latestJob.status} /><span><strong>{event.latestJob.type.replaceAll('_', ' ')}</strong><small>{event.latestJob.progress}% · {event.latestJob.progressMessage}</small></span></div>
            </div>
          )}
          {event.failureReason && <Notice tone="danger">{event.failureReason}</Notice>}
          <div className="link-list">
            {event.deploymentExplorerUrl && <a href={event.deploymentExplorerUrl} target="_blank" rel="noreferrer">Deployment transaction ↗</a>}
            {event.contractExplorerUrl && <a href={event.contractExplorerUrl} target="_blank" rel="noreferrer">VoteEvent contract ↗</a>}
          </div>
          {event.status === 'FAILED' && !event.snapshotRoot && <button className="button secondary align-start" type="button" disabled={Boolean(busy)} onClick={retrySnapshot}>{busy === 'snapshot' ? 'Queuing…' : 'Retry snapshot'}</button>}
          {event.snapshotRoot && event.deploymentBlock === null && event.status === 'SNAPSHOT_READY' && (
            <>
              <Notice>The snapshot is ready, but the previous sponsored deployment did not complete. Retry queues the same immutable one-contract configuration.</Notice>
              <button className="button primary align-start" type="button" disabled={Boolean(busy)} onClick={retryDeployment}>{busy === 'deployment' ? 'Queuing…' : 'Retry sponsored deployment'}</button>
            </>
          )}
        </section>
      </div>

      <section className="content-card">
        <div className="content-card-head"><div><h2>Investor communications</h2><p>Creator-signed messages are fetched by the dApp, verified again inside the Snap, and delivered to eligible installed wallets.</p></div><StatusPill status={event.snapDeliveryMode} /></div>
        {event.snapDeliveryMode === 'DISABLED' ? (
          <Notice>Snap delivery was disabled by the creator when this immutable event workflow was configured.</Notice>
        ) : event.deploymentBlock === null ? (
          <Notice>Communications become available after the VoteEvent address is known.</Notice>
        ) : (
          <form className="form-stack compact-stack" onSubmit={publish}>
            <div className="form-grid two">
              <label className="field"><span>Category</span><select value={message.category} onChange={(e) => setMessage((p) => ({ ...p, category: e.target.value }))}>{Object.values(COMMUNICATION_CATEGORY).map((value) => <option value={value} key={value}>{value.replaceAll('_', ' ')}</option>)}</select></label>
              <label className="field"><span>Audience</span><select value={event.snapDeliveryMode === 'SUBSCRIBERS_ONLY' ? 'SUBSCRIBERS' : message.audience} onChange={(e) => setMessage((p) => ({ ...p, audience: e.target.value }))} disabled={event.snapDeliveryMode === 'SUBSCRIBERS_ONLY'}>{event.snapDeliveryMode === 'ELIGIBLE' && <><option value="ALL_ELIGIBLE">All eligible holders</option><option value="NOT_VOTED">Eligible holders who have not voted</option></>}<option value="SUBSCRIBERS">Subscribed investors</option></select></label>
            </div>
            <label className="field"><span>Title</span><input value={message.title} onChange={(e) => setMessage((p) => ({ ...p, title: e.target.value }))} required /></label>
            <label className="field"><span>Message</span><textarea rows="4" value={message.body} onChange={(e) => setMessage((p) => ({ ...p, body: e.target.value }))} required /></label>
            <div className="form-grid two">
              <label className="field"><span>Publish at</span><input type="datetime-local" value={message.publishedAt} onChange={(e) => setMessage((p) => ({ ...p, publishedAt: e.target.value }))} required /></label>
              <label className="field"><span>Expires at</span><input type="datetime-local" value={message.expiresAt} onChange={(e) => setMessage((p) => ({ ...p, expiresAt: e.target.value }))} required /></label>
            </div>
            <button className="button primary align-start" type="submit" disabled={busy === 'communication'}>{busy === 'communication' ? 'Signing and publishing…' : 'Sign and publish communication'}</button>
          </form>
        )}
        {communications.length > 0 && <div className="job-list">{communications.map((communication) => <div key={communication.message_id}><StatusPill status={communication.category} /><span><strong>{communication.title}</strong><small>{formatDate(communication.published_at)} · {communication.audience.replaceAll('_', ' ')}</small></span></div>)}</div>}
      </section>
    </>
  );
}

function ResultsPage() {
  const { eventId } = useParams();
  const remote = useRemote(() => api(`/v1/events/${eventId}/results`), [eventId], { interval: 10_000 });
  if (remote.loading) return <Loading label="Reading on-chain tallies…" />;
  if (remote.error) return <Notice tone="danger">{remote.error}</Notice>;
  const result = remote.value;
  if (!result.available) return <Notice>Results become available after {formatDate(result.event.votingEndAt)}.</Notice>;
  return (
    <>
      <PageHeader eyebrow={`${result.event.tokenSymbol} · on-chain results`} title={result.event.title} body="Tallies are read directly from this event's VoteEvent contract." actions={<a className="button secondary" href={result.event.contractExplorerUrl} target="_blank" rel="noreferrer">View contract ↗</a>} />
      <div className="results-list">
        {result.proposals.map((proposal) => {
          const total = BigInt(proposal.totalVotingPower || 0);
          return (
            <section className="content-card result-card" key={proposal.index}>
              <h2>{proposal.index + 1}. {proposal.title}</h2>
              {proposal.options.map((option, optionIndex) => {
                const tally = BigInt(proposal.tallies[optionIndex] || 0);
                const percentage = total === 0n ? 0 : Number((tally * 10_000n) / total) / 100;
                return (
                  <div className="result-row" key={option.index}>
                    <div><strong>{option.text}</strong><span>{tally.toString()} votes · {percentage.toFixed(2)}%</span></div>
                    <div className="result-track"><i style={{ width: `${percentage}%` }} /></div>
                  </div>
                );
              })}
              <footer>Total participating voting power: {total.toString()}</footer>
            </section>
          );
        })}
      </div>
    </>
  );
}

function CommunicationsPage() {
  const wallet = useWallet();
  const [snap, setSnap] = useState(null);
  const [inbox, setInbox] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);
  const [eligibleEvents, setEligibleEvents] = useState([]);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [manualTokenAddress, setManualTokenAddress] = useState('');

  const refresh = useCallback(async () => {
    if (!wallet.account) return;
    const [nextSnap, nextSubscriptions, nextEvents] = await Promise.all([
      installedSnap().catch(() => null),
      wallet.ensureAuthenticated().then(() => api('/v1/snap/subscriptions')),
      api(`/v1/wallets/${wallet.account}/events?scope=all`),
    ]);
    setSnap(nextSnap);
    setSubscriptions(nextSubscriptions);
    setEligibleEvents(nextEvents);
    if (nextSnap) {
      const state = await invokeSnap('getInbox').catch(() => null);
      setInbox(state?.messages ?? []);
    }
  }, [wallet]);

  useEffect(() => { refresh().catch((error) => setMessage(error.message)); }, [refresh]);

  const install = async () => {
    setBusy('install'); setMessage('');
    try { await installSnap(); await refresh(); setMessage('PV Investor Communications enabled.'); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(''); }
  };

  const sync = async () => {
    setBusy('sync'); setMessage('');
    try {
      const result = await syncSnapInbox({ walletAddress: wallet.account, ensureAuthenticated: wallet.ensureAuthenticated, install: true });
      await refresh();
      setMessage(`Synced ${result.verified} verified communication(s); ${result.accepted?.length ?? 0} new.`);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(''); }
  };

  const subscribe = async (tokenAddress, enabled) => {
    setBusy(tokenAddress); setMessage('');
    try {
      await wallet.ensureAuthenticated();
      await api('/v1/snap/subscriptions', {
        method: 'POST',
        body: {
          tokenAddress,
          categories: ['EVENT_ANNOUNCEMENT', 'VOTING_OPEN', 'DEADLINE_REMINDER', 'DOCUMENT_UPDATE', 'RESULTS_AVAILABLE', 'GENERAL'],
          enabled,
        },
      });
      await refresh();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(''); }
  };

  const addManualSubscription = async (submitEvent) => {
    submitEvent.preventDefault();
    setBusy('manual-subscription'); setMessage('');
    try {
      await wallet.ensureAuthenticated();
      const inspected = await api('/v1/tokens/inspect', {
        method: 'POST',
        body: { tokenAddress: manualTokenAddress },
      });
      await api('/v1/snap/subscriptions', {
        method: 'POST',
        body: {
          tokenAddress: inspected.tokenAddress,
          categories: ['EVENT_ANNOUNCEMENT', 'VOTING_OPEN', 'DEADLINE_REMINDER', 'DOCUMENT_UPDATE', 'RESULTS_AVAILABLE', 'GENERAL'],
          enabled: true,
        },
      });
      setManualTokenAddress('');
      await refresh();
      setMessage(`Subscribed to ${inspected.name} (${inspected.symbol}).`);
    } catch (error) { setMessage(error.message); }
    finally { setBusy(''); }
  };

  if (!wallet.account) return <ConnectState body="Connect MetaMask to install the Snap and sync communications for this wallet." />;
  const tokenMap = new Map();
  eligibleEvents.forEach((event) => tokenMap.set(event.tokenAddress.toLowerCase(), {
    tokenAddress: event.tokenAddress,
    tokenName: event.tokenName,
    tokenSymbol: event.tokenSymbol,
  }));
  subscriptions.forEach((subscription) => tokenMap.set(subscription.token_address.toLowerCase(), {
    tokenAddress: subscription.token_address,
    tokenName: subscription.token_name || 'ERC-20 Token',
    tokenSymbol: subscription.token_symbol || 'TOKEN',
  }));
  const tokens = [...tokenMap.values()];
  const active = new Set(subscriptions
    .filter((item) => item.status === 'ACTIVE')
    .map((item) => item.token_address.toLowerCase()));
  return (
    <>
      <PageHeader eyebrow="MetaMask Snap" title="In-wallet investor communications" body="The dApp installs, verifies, and invokes the Snap. The Snap stores read/unread state and displays MetaMask notifications." />
      {message && <Notice tone={message.toLowerCase().includes('error') ? 'danger' : 'success'}>{message}</Notice>}
      <section className="content-card snap-hero">
        <div><span className={`snap-state${snap ? ' on' : ''}`}>{snap ? 'Enabled' : 'Not installed'}</span><h2>PV Investor Communications</h2><p>Verified creator-signed voting notices, deadline reminders, document updates, and results. Voting remains in this dApp.</p></div>
        <div className="snap-actions">
          {!snap && <button className="button primary" type="button" disabled={Boolean(busy)} onClick={install}>{busy === 'install' ? 'Installing…' : 'Enable communications'}</button>}
          <button className="button secondary" type="button" disabled={Boolean(busy)} onClick={sync}>{busy === 'sync' ? 'Syncing…' : 'Sync wallet inbox'}</button>
        </div>
      </section>
      <section className="content-card">
        <div className="content-card-head"><div><h2>Token subscriptions</h2><p>Subscriptions are required for subscriber-only discovery and delivery. Paste a standard Polygon Amoy ERC-20 address even before an event is visible.</p></div></div>
        <form className="field-row subscription-add" onSubmit={addManualSubscription}>
          <label className="field grow"><span>ERC-20 token address</span><input value={manualTokenAddress} onChange={(event) => setManualTokenAddress(event.target.value)} placeholder="0x…" required /></label>
          <button className="button primary field-button" type="submit" disabled={Boolean(busy) || !manualTokenAddress}>{busy === 'manual-subscription' ? 'Inspecting…' : 'Inspect and subscribe'}</button>
        </form>
        {!tokens.length ? <p>No token subscriptions yet.</p> : <div className="subscription-list">{tokens.map((token) => {
          const enabled = active.has(token.tokenAddress.toLowerCase());
          return <div key={token.tokenAddress}><strong>{token.tokenName} ({token.tokenSymbol})</strong><code>{shortAddress(token.tokenAddress, 10, 8)}</code><button className="button secondary small" type="button" disabled={Boolean(busy)} onClick={() => subscribe(token.tokenAddress, !enabled)}>{enabled ? 'Unsubscribe' : 'Subscribe'}</button></div>;
        })}</div>}
      </section>
      <section className="content-card">
        <div className="content-card-head"><div><h2>Snap inbox</h2><p>Messages shown here are stored locally in the installed Snap.</p></div><span>{inbox.filter((item) => !item.read).length} unread</span></div>
        {!inbox.length ? <p>No locally stored communications. Use Sync wallet inbox after an event creator publishes one.</p> : <div className="job-list">{inbox.map((item) => <div key={item.messageId}><StatusPill status={item.category} /><span><strong>{item.title}</strong><small>{item.eventTitle} · {formatDate(item.publishedAt)}</small><a href={item.actionUrl}>Open event</a></span></div>)}</div>}
      </section>
    </>
  );
}

function NotFound() {
  return <EmptyState title="Page not found" body="The requested V2 route does not exist." action={<Link className="button primary" to="/">Return home</Link>} />;
}

export default function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/ongoing" element={<OngoingPage />} />
        <Route path="/explore" element={<ExplorePage />} />
        <Route path="/completed" element={<CompletedPage />} />
        <Route path="/create" element={<CreatePage />} />
        <Route path="/my-events" element={<MyEventsPage />} />
        <Route path="/events/:eventId" element={<EventPage />} />
        <Route path="/events/:eventId/vote" element={<VotePage />} />
        <Route path="/events/:eventId/manage" element={<ManagePage />} />
        <Route path="/events/:eventId/results" element={<ResultsPage />} />
        <Route path="/communications" element={<CommunicationsPage />} />
        <Route path="/vote" element={<Navigate to="/ongoing" replace />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Shell>
  );
}
