-- 048_worker_metrics_grants.sql
--
-- /api/health has reported "degraded" since migration 024 because the
-- worker_metrics view calls pgmq.metrics_all(), which is SECURITY INVOKER:
-- it reads pgmq.meta, each queue table and its msg_id sequence, and calls
-- pgmq.format_table_name() with the caller's privileges. The service role
-- (the only reader of the view) had none of those grants, so the queue
-- probe failed with "permission denied for table meta".
--
-- Read-only grants, scoped to the two tayf queues. anon/authenticated stay
-- locked out (024's access model is unchanged).

begin;

grant usage on schema pgmq to service_role;
grant select on table pgmq.meta to service_role;
grant execute on function pgmq.format_table_name(text, text) to service_role;

do $$
declare q text;
begin
  for q in
    select queue_name from pgmq.meta
    where queue_name in ('cluster_work', 'image_backfill')
  loop
    execute format('grant select on table pgmq.%I to service_role', 'q_' || q);
    execute format(
      'grant select on sequence pgmq.%I to service_role',
      'q_' || q || '_msg_id_seq'
    );
  end loop;
end
$$;

commit;
