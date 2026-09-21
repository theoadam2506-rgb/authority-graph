# EVENT_MODEL — authority-graph

## Enveloppe commune

Tout événement, quel que soit son type, porte l'enveloppe suivante. Les champs
d'enveloppe ne sont jamais optionnels ; leur absence rend l'événement invalide à
l'ingestion (rejet, pas de valeur par défaut — cf. I1).

| Champ | Type | Attribué par | Description |
|---|---|---|---|
| `event_id` | identifiant opaque (UUID) | la source | Clé d'idempotence (I8). |
| `event_type` | enum | la source | Un des 9 types listés ci-dessous. |
| `occurred_at` | timestamp ISO 8601 | la source | Déclaratif, non fiable, jamais décisionnel (I4). Conservé pour l'audit ; signalé s'il dérive trop de `authority_time`. |
| `recorded_at` | timestamp ISO 8601 | Authority, à l'ingestion | Horloge d'infrastructure au moment où le store a vu l'événement. Diagnostic opérationnel uniquement, jamais décisionnel. |
| `authority_time` | timestamp ISO 8601 | Authority, à l'ingestion | Horloge décisionnelle, garantie monotone non décroissante par rapport à `sequence`. Seule horloge utilisée pour évaluer `expires_at` (I4). |
| `sequence` | entier strictement croissant | Authority, à l'ingestion | Ordre causal uniquement. Attribué atomiquement à l'append, jamais recalculé. Seul ordre utilisé pour déterminer l'état du graphe « à l'instant T » et pour I7 (I4, I3). |
| `principal_id` | identifiant opaque | la source | Le principal qui émet l'événement. Opaque, sans PII (I11). C'est ce champ, et lui seul, qui est confronté aux vérifications de droit d'émission (I12, I13, I14). |
| `assurance_level` | enum, valeur unique en V0 | Authority, à l'ingestion | Toujours `ASSERTED_UNVERIFIED` en V0 (I17) : aucune signature, aucune identité cryptographiquement vérifiée. Rappelle que `principal_id` est une affirmation du transport, pas une preuve. |
| `payload` | objet typé par `event_type` | la source | Voir sections ci-dessous. Aucun champ libre non typé. |

## Sémantique authority_time / sequence / occurred_at / recorded_at

- **`sequence`** répond à « quel événement avant lequel ». Compteur unique,
  strictement monotone, attribué atomiquement par Authority à l'append,
  indépendant de toute horloge. C'est l'ordre causal canonique : il détermine
  quels événements sont visibles pour une évaluation donnée, et à partir de quand
  une révocation (I7) ou une consommation (I16) prend effet.
- **`authority_time`** répond à « une délégation est-elle expirée maintenant ».
  C'est une horloge, pas un ordre : Authority l'attribue à l'ingestion, en
  garantissant qu'elle ne décroît jamais quand `sequence` augmente (si l'horloge
  système reculait, `authority_time` resterait égale à la valeur précédente plutôt
  que de reculer). C'est la seule quantité comparée à `expires_at`. Elle n'est
  jamais fournie par la source.
- **`occurred_at`** répond à « quand la source prétend que ceci s'est produit ».
  Déclaration non fiable par construction (source en retard, mal synchronisée, ou
  malveillante). N'intervient dans aucune branche de décision. Si
  `|authority_time − occurred_at|` dépasse `CLOCK_DRIFT_THRESHOLD` (constante
  nommée et configurée), `explain()` affiche `LATE_OR_BACKDATED_EVENT_OBSERVED`
  pour cet événement — un signal d'audit, jamais une entrée du calcul de décision.
- **`recorded_at`** répond à « quand l'infrastructure a physiquement vu passer cet
  événement ». Utile au monitoring d'ingestion (latence, sources en retard
  chronique). Distinct d'`authority_time` : `recorded_at` est une lecture brute de
  l'horloge d'infrastructure et n'offre aucune garantie de monotonicité ;
  `authority_time` est la valeur canonique, corrigée pour être monotone, que le
  moteur de décision peut utiliser en toute sécurité.

## Ingestion : store canonique vs journal de sécurité

Il existe deux journaux distincts :

1. **Le store canonique**, seul lu par `authorityAt()` / `explain()`. Il ne
   contient que des événements dont l'ingestion a réussi.
2. **Le journal de sécurité**, jamais lu par `authorityAt()`. Il enregistre les
   tentatives d'ingestion rejetées : `event_id` en conflit (I8), collision d'ID
   métier (voir plus bas), violation prouvée de I12/I13/I14 avec l'état canonique
   déjà connu au moment de l'ingestion. Chaque entrée porte : l'`event_id` tenté,
   le hash du ou des payloads en cause, un `reason_code`, et `recorded_at` (pas de
   `sequence` : ces tentatives n'intègrent jamais l'ordre causal canonique).

Une tentative d'ingestion rejetée ne modifie jamais le store canonique et n'a donc
aucune incidence sur une résolution future : ce n'est pas une exception à I3
(append-only), c'est l'absence d'écriture. La réponse `UNKNOWN` à une tentative
d'ingestion en conflit (I8) est une réponse synchrone à cet appel, pas une
promesse que les résolutions futures resteront `UNKNOWN` à cause de cet event_id.

Un événement structurellement valide dont l'ingestion ne peut pas encore juger
l'autorité (référence à un maillon pas encore arrivé — livraison hors-ordre) entre
en revanche dans le store canonique sans verdict d'autorité définitif : c'est la
résolution, avec toute l'information disponible à sa propre `sequence`, qui
tranche (I5, I12, I13, I14 sont donc vérifiés à l'ingestion **et** revérifiés à
chaque résolution — le resolver ne fait jamais confiance au verdict d'ingestion).

## Unicité des identifiants métier

`delegation_id`, `action_id` et `approval_id` sont des identifiants métier
distincts de `event_id`. Chacun doit être unique sur l'ensemble de son type
d'événement créateur :

| ID métier | Unique parmi | Sur collision (même ID, contenu différent, `event_id` différent) |
|---|---|---|
| `delegation_id` | tous les `DELEGATION_CREATED` + `SUBDELEGATION_CREATED` jamais ingérés | Le second événement est rejeté à l'ingestion, journalisé (journal de sécurité), jamais inséré dans le store canonique. |
| `action_id` | tous les `ACTION_REQUESTED` jamais ingérés | Idem. |
| `approval_id` | tous les `APPROVAL_REQUESTED` jamais ingérés | Idem. |

Cette règle est distincte d'I8 (qui déduplique par `event_id`) : deux événements
d'`event_id` différents peuvent tenter de réutiliser le même ID métier avec un
contenu différent (ex. faire passer une action à montant élevé pour l'action à
faible montant déjà approuvée) — c'est ce cas que l'unicité des ID métier ferme,
indépendamment de I8.

## Empreinte canonique d'action (`action_fingerprint`, I15)

Calculée par Authority, jamais fournie telle quelle par la source sans
vérification. Entrées, dans cet ordre exact, chacune convertie en chaîne UTF-8 (un
champ absent est représenté par le sentinel littéral `∅`, un entier par sa
représentation décimale sans zéro ni signe non significatif) :

1. `capability.resource`
2. `capability.action`
3. `parameters.amount` (ou `∅`)
4. `parameters.recipient` (ou `∅`)

Les quatre segments sont joints par le séparateur U+001F (unit separator) en une
seule chaîne, puis hashés en SHA-256, encodés en hexadécimal minuscule. Le résultat
est `action_fingerprint`. Cette fonction est pure et déterministe (I2) : mêmes
entrées ⇒ même empreinte, toujours.

## Les 9 types d'événements

### 1. `DELEGATION_CREATED`

Une autorité crée une délégation racine — `parent_delegation_id` est
obligatoirement `null` pour ce type.

| Champ payload | Type | Description |
|---|---|---|
| `delegation_id` | identifiant opaque | Unique (voir unicité des ID métier). |
| `grantor_principal_id` | identifiant opaque | Le principal qui accorde. |
| `grantor_type` | `HUMAN_ROOT` \| `AGENT` | Obligatoire pour une délégation racine. `AUTHORIZED` exige `HUMAN_ROOT` au sommet de la chaîne (trust anchor). |
| `grantee_principal_id` | identifiant opaque | Le principal qui reçoit. |
| `capabilities` | liste de `{resource, action}` exacts | Aucun wildcard (I9). |
| `can_delegate` | booléen, obligatoire | Droit de sous-déléguer (I12). Absence ⇒ `UNKNOWN` pour toute résolution qui en dépend. Une délégation confère toujours l'exécution des capacités listées ; elle ne confère la re-délégation que si `can_delegate: true`. |
| `expires_at` | timestamp **ou** `{no_expiry: true}` | Obligatoire — jamais de null implicite (I1). Comparé à `authority_time`, jamais à `occurred_at`/`recorded_at` (I4). |
| `max_amount` | optionnel `{value: entier, currency}` | Plafond structurel par action, utilisé pour borner les sous-délégations (I5). Absence = illimité (+∞) pour cette comparaison. |
| `total_budget` | optionnel `{value: entier, currency}` | Plafond agrégé : à aucune `sequence`, la somme des `parameters.amount` des `ACTION_EXECUTED` dont `authority_chain_ref` passe par cette délégation ou par l'un de ses descendants ne doit dépasser cette valeur. Absence = illimité (+∞). Débité au niveau de **chaque** ancêtre borné d'une chaîne, pas seulement à la délégation terminale invoquée (voir `SPEC.md`, « Sémantique de total_budget »). V0 garantit le calcul honnête et déterministe de ce plafond à la résolution, pas sa réservation avant exécution (voir A24, `THREAT_MODEL.md`). |
| `automatic_max_amount` | entier, obligatoire si `max_amount` ou toute action à montant est invoquée sur cette délégation | Sous ce seuil : pas d'approbation requise. |
| `approval_max_amount` | entier, même condition | Entre `automatic_max_amount` (exclu) et ce seuil (inclus) : approbation requise. Au-delà : `DENIED`. Doit satisfaire `automatic_max_amount ≤ approval_max_amount ≤ max_amount` (`max_amount` traité comme +∞ si absent) ; ordre violé ⇒ délégation malformée, `UNKNOWN` pour toute résolution qui en dépend. |
| `parent_delegation_id` | `null` (fixe pour ce type) | Marque une délégation racine. |

### 2. `DELEGATION_REVOKED`

Révoque une délégation existante. Ne signifie jamais qu'elle était erronée dès
l'origine (voir « Révocation ≠ invalidation », `SPEC.md`) — `EVENT_INVALIDATED`
serait le type approprié pour ce second cas, non implémenté en V0.

| Champ payload | Type | Description |
|---|---|---|
| `delegation_id` | identifiant opaque | La délégation ciblée (doit exister dans le store canonique). |
| `revoked_by_principal_id` | identifiant opaque | Doit être égal au `principal_id` de l'enveloppe (l'émetteur). |
| `reason_code` | enum opaque | Sans texte libre ni PII. |

Autorisée (I13) seulement si l'émetteur (`principal_id`) est le
`grantor_principal_id` de la délégation ciblée, ou le `grantor_principal_id` de la
délégation racine de cette chaîne. Sinon : ignorée pour la décision, journalisée
comme tentative. Si autorisée, effective à partir de son propre `sequence` (I4, I7)
pour ce maillon et tous ses descendants exclusivement dépendants.

### 3. `SUBDELEGATION_CREATED`

Structurellement identique à `DELEGATION_CREATED` (mêmes champs de contrainte),
sans `grantor_type` (le grantor d'une sous-délégation est par construction un
`AGENT`, le grantee du parent), avec `parent_delegation_id` obligatoire et
non-null.

| Champ payload | Type | Description |
|---|---|---|
| `delegation_id` | identifiant opaque | Unique (voir unicité des ID métier). |
| `parent_delegation_id` | identifiant opaque, obligatoire | La délégation dont celle-ci dérive. |
| `grantor_principal_id` | identifiant opaque | Doit être égal au `principal_id` de l'enveloppe **et** au `grantee_principal_id` du parent (I12). |
| `grantee_principal_id` | identifiant opaque | Le principal qui reçoit. |
| `capabilities` | liste de `{resource, action}` exacts | Sous-ensemble exact des capacités du parent. |
| `can_delegate` | booléen, obligatoire | Idem I12. |
| `expires_at` | timestamp **ou** `{no_expiry: true}` | ≤ `expires_at` du parent (`no_expiry` traité comme +∞). |
| `max_amount`, `total_budget`, `automatic_max_amount`, `approval_max_amount` | mêmes types que `DELEGATION_CREATED` | Chacun ≤ la valeur correspondante du parent ; pour `total_budget`, ≤ le **reste** du parent à la `sequence` de résolution (`total_budget` déclaré du parent moins la somme des `parameters.amount` de toutes les `ACTION_EXECUTED` autorisées dont l'`authority_chain_ref` passe par le parent ou un de ses descendants, à `sequence` ≤ celle de l'évaluation). |

Valide (I12) seulement si l'émetteur est le grantee du parent et si le parent porte
`can_delegate: true`. Vérifié à l'ingestion avec l'état canonique alors connu,
revérifié à chaque résolution (le parent a pu être révoqué, ou son reste de budget
a pu diminuer, depuis).

### 4. `ACTION_REQUESTED`

| Champ payload | Type | Description |
|---|---|---|
| `action_id` | identifiant opaque | Unique (voir unicité des ID métier). |
| `requesting_principal_id` | identifiant opaque | Le principal qui demande à agir. |
| `delegation_id` | identifiant opaque | La délégation/sous-délégation invoquée. |
| `capability_requested` | `{resource, action}` exact | Capacité exacte requise. |
| `parameters` | `{amount?: entier, currency?, recipient?: identifiant opaque}` | Seuls `amount`, `currency` et `recipient` sont typés et entrent dans `action_fingerprint` (I15) ; aucun autre champ métier n'est interprété par le moteur en V0. |

### 5. `APPROVAL_REQUESTED`

Purement informatif en V0 : le moteur calcule lui-même `REQUIRES_APPROVAL` à
partir des seuils de la délégation invoquée et de `parameters.amount` ; cet
événement documente/route la demande vers un humain mais n'est pas consulté par la
décision.

| Champ payload | Type | Description |
|---|---|---|
| `approval_id` | identifiant opaque | Unique (voir unicité des ID métier). |
| `action_id` | identifiant opaque | L'action concernée. |
| `requested_from_principal_id` | identifiant opaque | Informatif uniquement — ne confère aucune autorité (I14). |
| `policy_reason_code` | enum opaque | Raison informative (ex. `AMOUNT_BAND_APPROVAL`). |

### 6. `APPROVAL_GRANTED`

| Champ payload | Type | Description |
|---|---|---|
| `approval_id` | identifiant opaque | Doit référencer une `APPROVAL_REQUESTED` existante. |
| `action_id` | identifiant opaque | Doit correspondre à l'`action_id` de la demande. |
| `approving_principal_id` | identifiant opaque | Doit être égal au `principal_id` de l'enveloppe **et** au `grantor_principal_id` de la délégation dont les seuils ont produit `REQUIRES_APPROVAL` (I14). |

Pas de champ `granted_scope` : l'empreinte canonique de l'`ACTION_REQUESTED`
référencée (I15) *est* le scope exact couvert — aucune structure supplémentaire
n'est nécessaire. Sémantique fixe (I6, I16) : usage unique, lié à `action_id` et à
`action_fingerprint`, sans effet sur l'état de la délégation.

### 7. `APPROVAL_DENIED`

| Champ payload | Type | Description |
|---|---|---|
| `approval_id` | identifiant opaque | Doit référencer une `APPROVAL_REQUESTED` existante. |
| `action_id` | identifiant opaque | L'action concernée. |
| `denying_principal_id` | identifiant opaque | Doit être égal au `principal_id` de l'enveloppe **et** au `grantor_principal_id` habilité (même règle I14 que pour `APPROVAL_GRANTED`, pour éviter qu'un tiers non habilité bloque une action par un faux refus). |
| `reason_code` | enum opaque | Raison du refus. |

Portée du refus : il vise exclusivement l'`approval_id` (donc l'`ACTION_REQUESTED`
de même `action_id`) qu'il cible — jamais l'`action_fingerprint` de façon
permanente. Une nouvelle `APPROVAL_REQUESTED`, avec un nouvel `approval_id`,
portant sur une action de `action_fingerprint` identique (même capacité, même
montant, même destinataire) est recevable et s'évalue indépendamment de ce refus.
`action_fingerprint` n'est jamais utilisé comme clé de liste noire persistante —
ce serait de la politique métier hors du périmètre déterministe de V0.

### 8. `ACTION_EXECUTED`

Enregistre l'exécution effective d'une action, après que le moteur a rendu
`AUTHORIZED` pour elle.

| Champ payload | Type | Description |
|---|---|---|
| `action_id` | identifiant opaque | L'action exécutée (doit référencer un `ACTION_REQUESTED` existant, `AUTHORIZED` à sa `sequence` d'exécution). |
| `executed_by_principal_id` | identifiant opaque | Le principal exécutant. |
| `action_fingerprint` | chaîne hexadécimale | Empreinte canonique (I15) des paramètres réellement exécutés, calculée de façon identique à celle de l'`ACTION_REQUESTED`. Doit être strictement égale à l'empreinte de l'`ACTION_REQUESTED` de même `action_id`, sinon `DENIED`. |
| `decision_sequence` | entier | `sequence` à laquelle la décision `AUTHORIZED` a été calculée. |
| `authority_chain_ref` | liste ordonnée de `delegation_id` (+ `approval_id` le cas échéant) | Chaîne exacte, unique, entièrement valide à `decision_sequence`, utilisée pour la décision. Fixée à l'exécution, jamais recalculée ni réattribuée (I3) : seule cette chaîne débite les ancêtres bornés par `total_budget` qu'elle contient. Le resolver peut connaître d'autres chaînes valides vers le même principal (règle multi-chemin) ; un agent ne peut pas en invoquer une autre après coup au motif qu'elle disposerait de plus de budget restant. |
| `execution_result` | enum opaque | Statut d'exécution, sans détail métier ni PII. |

Consommation d'un `approval_id` (I16) : si `authority_chain_ref` référence un
`approval_id`, cette `ACTION_EXECUTED` en devient la seule consommation valide si
elle a la plus petite `sequence` parmi toutes les `ACTION_EXECUTED` référençant ce
même `approval_id` ; toute autre est `DENIED`.

Un `ACTION_EXECUTED` sans décision `AUTHORIZED` démontrable à `decision_sequence`,
ou dont l'`action_fingerprint` ne correspond pas, est une violation détectée par le
resolver, pas un cas silencieusement accepté par le schéma.

### 9. `CAPABILITY_ISSUED`

Produit uniquement par la commande d'émission de capacité
(`issueCapability`/`issueCapabilityIdempotently`, PR3 à PR4B-5A — voir
`SPEC.md`, I21–I24), jamais par la voie d'ingestion `authorityAt`/
`explainAction` décrite plus haut. Contrairement aux huit types
précédents, cet événement n'est jamais fourni par une source externe : il
est auto-produit par Authority elle-même, au moment où la commande décide
d'accepter l'émission.

| Champ payload | Type | Description |
|---|---|---|
| `capability_id` | identifiant opaque | Identifiant métier protégé de la capacité émise ; une collision (générateur forcé ou défectueux) est rejetée fail-closed (I24), jamais silencieusement acceptée. |
| `action_id` | identifiant opaque | L'`ACTION_REQUESTED` dont la commande découle. |
| `action_fingerprint` | chaîne hexadécimale | Empreinte canonique (I15) de l'action résolue, calculée de façon identique aux autres types. |
| `decision_sequence` | entier | La `snapshotSequence` au moment de la décision — un ordre causal, jamais dérivé du temps (I21). |
| `granted_chain_ref` | liste ordonnée de maillons | La chaîne GRANTED canonique résolue pour la délégation invoquée. |
| `enforcement_point_id` | identifiant opaque | Le point d'application demandé par la commande — copié tel quel si l'émission réussit, jamais vérifié contre un registre d'habilitation (aucun tel registre n'existe en V0). |
| `expires_at` | timestamp | Fournie par une politique injectée (dépendance de la commande), ancrée sur le même `authorityTime` explicite que la décision — jamais un instant reconstruit ou lu en direct. |

Champs d'enveloppe, particularités pour ce type :

- **`occurred_at`** : égal à `authorityTime`, l'instant explicite auquel la
  décision a été prise et la capacité construite (I21). Cette égalité ne
  représente **jamais** l'instant où l'écriture a été physiquement rendue
  durable — voir `recorded_at`, ci-dessous, pour cette notion distincte.
- **`recorded_at`** : lue séparément depuis l'horloge d'infrastructure au
  moment où le store voit effectivement passer l'événement, exactement
  comme pour tout autre type. Aucune relation d'ordre absolue entre
  `recorded_at` et `occurred_at` n'est garantie pour `CAPABILITY_ISSUED` :
  ce sont deux horloges de nature différente, jamais comparées entre elles
  par le moteur.
- **`authority_time`** : égal à `authorityTime`, l'instant de confiance
  explicite fourni à la commande — jamais reconstruit du store.
- **`principal_id`** : champ d'enveloppe obligatoire (comme pour tout
  événement), ici renseigné avec l'identité du demandeur authentifié
  (`AuthenticatedPrincipal`). Il ne doit **pas** être lu comme désignant un
  auteur humain ou un agent ayant personnellement réalisé l'acte d'émission
  : aucun participant du graphe de délégation ne « accorde » cet événement
  au sens où un `grantor_principal_id`/`approving_principal_id` le fait
  ailleurs. C'est un champ conservé pour la cohérence structurelle de
  l'enveloppe commune, pas une attribution d'autorité ni une preuve
  d'identité.

Un `CAPABILITY_ISSUED` n'est produit **que** sur une décision acceptée.
Toute commande refusée — y compris pour `STALE_AUTHORITY_TIME` (I22) —
n'écrit jamais cet événement, quel que soit le nombre de tentatives sous
la même clé d'idempotence ; voir `SPEC.md`, I22 et I24, pour le détail
normatif. `STALE_AUTHORITY_TIME` n'est pas un type d'événement : c'est un
résultat de refus de la commande elle-même, jamais une donnée journalisée
au sens de ce document.

Un rejeu idempotent (`REPLAYED`, sous la même clé) ne crée jamais un second
`CAPABILITY_ISSUED` : le résultat retourné est celui de l'exécution
d'origine, sans nouvel événement ni nouvelle évaluation.
