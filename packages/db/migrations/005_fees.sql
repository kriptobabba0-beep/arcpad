-- Escrow olaylari. Dogrulandi (contracts/src/FeeEscrow.sol @26ce330 satir
-- 95-96):
--   event Deposited(address indexed recipient, address indexed from, uint256 amount);
--   event Claimed(address indexed recipient, uint256 amount);
-- `deposit` sifir tutarda ZeroAmount ile, `claim` sifir bakiyede
-- NothingToClaim ile revert eder -- yani `amount_wei > 0` CHECK'i mesru bir
-- olayi reddedemez.
CREATE TABLE fee_events (
  event_seq     bigint PRIMARY KEY,
  block_number  bigint NOT NULL,
  log_index     integer NOT NULL CHECK (log_index BETWEEN 0 AND 1048575),
  tx_hash       text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  block_time    timestamptz NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('deposit','claim')),
  recipient     text NOT NULL CHECK (recipient ~ '^0x[0-9a-f]{40}$'),
  -- `Deposited.from` yatiran adrestir, yani CURVE. Bu, ucretin hangi
  -- launch'tan geldigini verir ve creator kazancinin launch basina
  -- dokumunu MUMKUN kilar (Task 10). `Claimed`'da from YOKTUR -> NULL.
  from_addr     text CHECK (from_addr ~ '^0x[0-9a-f]{40}$'),
  amount_wei    numeric(78,0) NOT NULL CHECK (amount_wei > 0),
  CONSTRAINT deposit_has_from CHECK ((kind = 'deposit') = (from_addr IS NOT NULL))
);
CREATE INDEX fee_events_recipient_seq_idx ON fee_events (recipient, event_seq DESC);
CREATE INDEX fee_events_from_seq_idx      ON fee_events (from_addr, event_seq DESC);

CREATE TABLE fee_balances (
  recipient          text PRIMARY KEY CHECK (recipient ~ '^0x[0-9a-f]{40}$'),
  claimable_wei      numeric(78,0) NOT NULL CHECK (claimable_wei >= 0),
  deposited_total_wei numeric(78,0) NOT NULL CHECK (deposited_total_wei >= 0),
  claimed_total_wei  numeric(78,0) NOT NULL CHECK (claimed_total_wei >= 0),
  last_seq           bigint NOT NULL,
  -- Escrow'un kendi defter esitligi. Kirilirsa bir olay atlanmis demektir.
  CONSTRAINT claimable_is_the_difference
    CHECK (claimable_wei = deposited_total_wei - claimed_total_wei)
);
