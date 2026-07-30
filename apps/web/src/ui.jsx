import { Link } from 'react-router-dom';
import { formatUnits } from 'ethers';

export function shortAddress(value, leading = 6, trailing = 4) {
  if (!value) return '—';
  return `${value.slice(0, leading)}…${value.slice(-trailing)}`;
}

export function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function formatAmount(raw, decimals = 18, maximumFractionDigits = 4) {
  try {
    const value = formatUnits(String(raw ?? 0), Number(decimals));
    const [integerPart, fractionPart = ''] = value.split('.');
    const groupedInteger = BigInt(integerPart || '0').toLocaleString();
    const trimmedFraction = fractionPart.slice(0, maximumFractionDigits).replace(/0+$/, '');
    return trimmedFraction ? `${groupedInteger}.${trimmedFraction}` : groupedInteger;
  } catch {
    return String(raw ?? '0');
  }
}

export function statusTone(status) {
  if (['OPEN', 'CONFIRMED', 'VERIFIED', 'SNAPSHOT_READY', 'SCHEDULED', 'COMPLETED'].includes(status)) return 'success';
  if (['FAILED', 'REJECTED'].includes(status)) return 'danger';
  if (['CLOSED', 'DEPLOYING', 'DEPLOYMENT_QUEUED', 'SNAPSHOT_RUNNING', 'SUBMITTED', 'QUEUED'].includes(status)) return 'warning';
  return 'info';
}

export function StatusPill({ status }) {
  return <span className={`status-pill ${statusTone(status)}`}>{String(status ?? 'UNKNOWN').replaceAll('_', ' ')}</span>;
}

export function Notice({ tone = 'info', children }) {
  const className = tone === 'danger' ? 'inline-error' : tone === 'success' ? 'inline-success' : 'notice-card';
  return <div className={className}>{children}</div>;
}

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="state-card">
      <div className="spinner" />
      <p>{label}</p>
    </div>
  );
}

export function EmptyState({ title, body, action }) {
  return (
    <div className="state-card">
      <span className="feature-number">◇</span>
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function EventCard({ event, showEligibility = false, directToVote = false }) {
  const canOpenVote = directToVote
    && event.status === 'OPEN'
    && event.eligibility?.eligible
    && !event.eligibility?.hasVoted;
  const destination = event.status === 'CLOSED'
    ? `/events/${event.id}/results`
    : canOpenVote
      ? `/events/${event.id}/vote`
      : `/events/${event.id}`;
  return (
    <Link className="event-card" to={destination}>
      <div className="event-card-head">
        <div className="event-token">
          <span>{event.tokenSymbol?.slice(0, 4) || 'ERC'}</span>
          <div>
            <h3>{event.title}</h3>
            <p>{event.tokenName} · {event.tokenSymbol}</p>
          </div>
        </div>
        <StatusPill status={event.status} />
      </div>
      <p className="event-description">{event.description || 'Proxy-voting event for eligible record-date holders.'}</p>
      <div className="event-metrics">
        <span><b>Record date</b>{formatDate(event.recordDateAt)}</span>
        <span><b>Voting ends</b>{formatDate(event.votingEndAt)}</span>
        <span><b>Ratio</b>{event.tokenToVoteRatio} token(s) / vote</span>
        {showEligibility && event.eligibility && (
          <span><b>Voting power</b>{event.eligibility.votingPower}</span>
        )}
      </div>
      <div className="event-card-foot">
        <span>{String(event.authenticityStatus).replaceAll('_', ' ')}</span>
        {event.eligibility?.hasVoted
          ? <span className="integrity-ok">✓ Ballot recorded or queued</span>
          : <span>{canOpenVote ? 'Open voting dashboard →' : 'View event →'}</span>}
      </div>
    </Link>
  );
}
