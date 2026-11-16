# Authority Conformance Lab V0 - Rego policy for OPA.
#
# AUTHORSHIP AND STATUS (read this before quoting any result):
#   * Written by the Authority Graph project, solely to express the policy of
#     the two scenarios in conformance/scenarios/ (revocation, excessive
#     delegation) in Rego. It is NOT OPA's own policy, NOT a recommended
#     production policy, and NOT an independent validation of OPA's security.
#   * What a run shows: a real OPA process, loaded with THIS policy, returns
#     the same allow/deny as the Authority engine on these probes (or not).
#     It says nothing about any other policy or any other OPA deployment.
#
# Input contract (built by the lab's HTTP adapter, see src/conformance/adapter.ts):
#   input.request = {agent, capability: "resource.action", amount: {value, currency}, human_root, at}
#   input.log     = the visible log prefix, scenario events with a 1-based "sequence".
# Output: data.authority_conformance.decision = {allow: bool, reason: string}
#
# Simplifications (stated, not hidden): no expiry, no approvals, one monetary
# limit per grant, exact capability match, single-parent chains.
package authority_conformance

import rego.v1

default allow := false

delegations[id] := e if {
	some e in input.log
	e.type in {"delegate", "subdelegate"}
	id := e.id
}

revoked contains e.target if {
	some e in input.log
	e.type == "revoke"
}

parents_of(e) := [e.parent] if e.type == "subdelegate"

parents_of(e) := [] if e.type == "delegate"

parent_graph := {id: parents_of(e) | some id, e in delegations}

leaves contains id if {
	some id, e in delegations
	e.grantee == input.request.agent
}

request_capability := input.request.capability

# A link of a chain is "bad" when any rule of the scenarios' policy is violated.
bad_link contains id if {
	some id, _ in delegations
	revoked[id]
}

bad_link contains id if {
	some id, e in delegations
	not request_capability in e.capabilities
}

bad_link contains id if {
	some id, e in delegations
	e.limit.currency != input.request.amount.currency
}

bad_link contains id if {
	some id, e in delegations
	input.request.amount.value > e.limit.value
}

# Root: must be granted by the declared human root.
bad_link contains id if {
	some id, e in delegations
	e.type == "delegate"
	e.grantor != input.request.human_root
}

# Sub-delegation: parent must exist, allow delegation, be held by the grantor...
bad_link contains id if {
	some id, e in delegations
	e.type == "subdelegate"
	not delegations[e.parent]
}

bad_link contains id if {
	some id, e in delegations
	e.type == "subdelegate"
	p := delegations[e.parent]
	not p.can_delegate
}

bad_link contains id if {
	some id, e in delegations
	e.type == "subdelegate"
	p := delegations[e.parent]
	p.grantee != e.grantor
}

# ...and must not exceed the parent (limit, currency, capability set).
bad_link contains id if {
	some id, e in delegations
	e.type == "subdelegate"
	p := delegations[e.parent]
	e.limit.value > p.limit.value
}

bad_link contains id if {
	some id, e in delegations
	e.type == "subdelegate"
	p := delegations[e.parent]
	e.limit.currency != p.limit.currency
}

bad_link contains id if {
	some id, e in delegations
	e.type == "subdelegate"
	p := delegations[e.parent]
	some c in e.capabilities
	not c in p.capabilities
}

chain_ok(leaf) if {
	count({i | some i in graph.reachable(parent_graph, {leaf}); bad_link[i]}) == 0
}

allow if {
	some leaf in leaves
	chain_ok(leaf)
}

reason := "CHAIN_VALID" if allow

else := "NO_DELEGATION_TO_AGENT" if count(leaves) == 0

else := "A_DELEGATION_IN_EVERY_CHAIN_IS_REVOKED_OR_OVER_LIMIT_OR_NOT_COVERING"

decision := {"allow": allow, "reason": reason}
