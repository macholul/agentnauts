-- A computer can disconnect itself (`agentnauts disconnect`).
--
-- The daemon holds no account session, so it cannot call revoke_agent. It
-- proves it owns its key to the agent-auth Edge Function (a signed
-- timestamp), and the function calls this to remove every connection of
-- that key. Only the function (service role) may call it.

create or replace function public.agent_logout(p_public_key text)
returns integer
language sql security definer set search_path = public
as $$
  with gone as (
    delete from public.project_agents where public_key = p_public_key returning 1
  )
  select count(*)::integer from gone;
$$;

revoke execute on function public.agent_logout(text) from public, anon, authenticated;
grant execute on function public.agent_logout(text) to service_role;
