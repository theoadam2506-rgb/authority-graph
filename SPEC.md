# SPEC — authority-graph

## Le problème

Un agent IA exécute une action. Un humain doit pouvoir répondre, des mois plus tard,
à la question : *quelle autorité couvrait exactement cette action, à l'instant T,
et pourquoi ?* Aujourd'hui cette autorité est dispersée entre des logs applicatifs,
des messages Slack, des tickets d'approbation et la mémoire des gens. Rien n'est
rejouable, rien n'est vérifiable, et personne ne peut prouver après coup qu'une
délégation n'a pas été étendue, backdatée, réutilisée hors de son cadre, ou émise
par quelqu'un qui n'en avait pas le droit. authority-graph reconstruit cette chaîne
d'autorité de façon déterministe à partir d'un flux d'événements append-only :
ancre humaine racine → délégation → sous-délégation → approbation ponctuelle →
action de l'agent. Le moteur ne juge jamais sur l'intention ou le contenu de
l'action elle-même : il vérifie que la chaîne d'autorité formelle, valide à la
séquence d'ingestion considérée, couvre exactement la capacité demandée — et que
chaque maillon de cette chaîne a été émis par un principal qui avait effectivement
le droit de l'émettre. Toute incertitude structurelle doit bloquer, jamais
autoriser par défaut.

## Les deux opérations du moteur

Le moteur expose exactement deux opérations. Il n'existe pas d'entrée unique
figée sur un `ACTION_REQUESTED` : une version antérieure de cette spec en
décrivait une seule ; l'audit adverse a montré que cela rendait le moteur
structurellement dépendant d'un événement historique pour répondre à une
question sur l'état courant de l'autorité, et confondait deux questions de
nature différente. Les quatre sorties de la section suivante sont produites
par l'une ou l'autre de ces deux opérations, jamais par un troisième chemin.

### `authorityAt(events, query, { atSequence, authorityTime })` — question prospective

Répond à : *cette action serait-elle autorisée, dans cet état ?* La requête est

```
{ agentId, principalId, capability, parameters }
```

Le troisième paramètre n'est plus un simple `atSequence` (correction PROMPT
3b) : c'est un couple explicite `{ atSequence, authorityTime }`.

- `atSequence` répond à « quels événements sont visibles » (I4, ordre causal).
- `authorityTime` répond à « une `expires_at` donnée est-elle déjà passée »
  (I4, horloge). C'est l'horloge de confiance **au moment de l'appel**,
  fournie explicitement par l'appelant — jamais dérivée d'`occurred_at`
  (déclaratif, non fiable par construction : le dériver en horloge
  décisionnelle, même « seulement pour le déterminisme des tests »,
  réintroduit exactement le risque de backdating qu'I4 existe pour
  empêcher), et jamais lue depuis une horloge murale en direct (`Date.now()`
  est interdit dans tout le moteur, qui reste une fonction pure). Ce n'est
  pas non plus `max(authority_time des événements visibles)` : le temps qui
  passe ne produit pas nécessairement d'événement, et sans nouvel événement
  pendant trois heures, cette dérivation ferait paraître valide pour
  toujours une délégation expirée depuis trois heures. En production, la
  couche d'admission fournit `authorityTime` à partir de sa propre horloge
  de confiance ; dans les tests, des valeurs fixes sont injectées.

- `agentId` : le principal qui exercerait la capacité — le délégataire évalué.
- `principalId` : le `HUMAN_ROOT` que l'appelant attend comme responsable de
  cette autorité. `authorityAt` ne répond pas seulement « `agentId` est-il
  autorisé par *un* humain quelconque », mais « `agentId` est-il autorisé,
  spécifiquement sous l'autorité de `principalId` ». Une chaîne par ailleurs
  entièrement valide mais enracinée chez un `HUMAN_ROOT` *différent* de celui
  asserté ici est `DENIED` pour cette paire précise (preuve positive que cette
  paire n'a pas autorité) — jamais acceptée sous le mauvais humain, et jamais
  `UNKNOWN` non plus.

`authorityAt` **ne requiert et ne lit jamais un `ACTION_REQUESTED`
préexistant** : le moteur ne doit pas être structurellement dépendant d'un
événement historique pour répondre à une question sur l'état de l'autorité à
un instant donné. Conséquence directe pour la bande d'approbation : une
`APPROVAL_GRANTED` valide et **non consommée**, dont l'empreinte (I15)
correspond exactement à `(capability, parameters)` de la requête, suffit à
produire `AUTHORIZED`. Un `APPROVAL_DENIED`, à lui seul, **ne peut jamais**
faire basculer une question prospective en `DENIED` : un refus vise une
demande passée précise, identifiée par son `approval_id` (voir « Portée d'un
refus » ci-dessous) — il n'a aucun pouvoir sur une question générale et
non ancrée à cette demande. Seule une approbation *consommée* (I16) produit
`DENIED` pour une question prospective portant sur la même empreinte ; en
l'absence de toute approbation, valide ou non, la réponse est
`REQUIRES_APPROVAL` — jamais `DENIED` sur la seule foi d'un refus passé et
non lié.

### `explainAction(events, { actionId }, { atSequence, authorityTime })` — question historique

Répond à : *que s'est-il passé pour cette action précise, et pourquoi ?*
Retrouve l'`ACTION_REQUESTED` immuable référencé par `actionId` — son
`agentId` (`requesting_principal_id`), sa capacité et ses paramètres, donc son
empreinte canonique (I15), ne changent jamais après coup — puis appelle la
même évaluation qu'`authorityAt`, avec deux différences :

- l'historique propre de **cette** action (sa propre `APPROVAL_REQUESTED` et
  la décision qui la concerne, le cas échéant) est la source prioritaire pour
  expliquer ce qui lui est arrivé, y compris un refus qui la vise directement
  — alors qu'`authorityAt` ne peut jamais tenir compte d'un refus, faute
  d'action à laquelle le rattacher ;
- si une `ACTION_EXECUTED` existe pour cet `actionId`, l'autorité est *aussi*
  résolue à son `decision_sequence` (« était-ce autorisé au moment de la
  décision ? »), et l'empreinte réellement exécutée (`action_fingerprint`) est
  comparée à l'empreinte immuable de la requête (I15) : toute divergence est
  `DENIED` à ce point de décision, quoi que dise par ailleurs l'état courant.

`explainAction` **n'utilise jamais l'heure courante**. Le couple `{
atSequence, authorityTime }` de la requête n'anchore que `currentAuthority` ;
l'autorité au `decision_sequence` de l'exécution est évaluée avec une horloge
**reconstruite**, jamais lue en direct : le plus grand `authority_time` parmi
les événements visibles à ce `decision_sequence` — chacun de ces
`authority_time` ayant lui-même déjà été assigné à l'ingestion par la même
horloge de confiance, jamais par `occurred_at`. Reconstruire ainsi un point
**passé et figé** est légitime (il n'y a pas de risque de « temps passé sans
événement » pour un instant déjà entièrement journalisé) là où ce serait
insuffisant pour représenter *maintenant* dans une requête `authorityAt`.

`explainAction` produit donc une sortie composite, par exemple :

```
ACTION_EXECUTED at sequence 152
authority at decision sequence 151: AUTHORIZED
approval consumed by execution 152
current authority at sequence 190: DENIED
```

Une exécution historiquement autorisée le reste pour toujours à son
`decision_sequence` — I3 interdit de réécrire cette conclusion — même quand
`currentAuthority` (l'autorité pour la même empreinte, réévaluée à la
`sequence` de la requête) lit désormais `DENIED` parce que l'approbation à
usage unique qui la couvrait a depuis été consommée (I6, I16).

## Les 4 sorties du moteur

Qu'elle soit produite par `authorityAt` (prospective) ou par `explainAction`
(historique, via l'`ACTION_REQUESTED` qu'elle résout), toute évaluation
retourne exactement une des quatre valeurs suivantes :

1. **AUTHORIZED** — Il existe une chaîne de délégation ininterrompue, où chaque
   maillon (délégation, sous-délégation, approbation le cas échéant) a été émis
   par un principal ayant effectivement le droit de l'émettre (I12, I13, I14),
   non expirée (au sens `authority_time`, voir Blocker 2), non révoquée par une
   révocation elle-même autorisée, respectant la profondeur maximale, dont chaque
   maillon couvre au moins la capacité et les contraintes demandées, jusqu'au
   `HUMAN_ROOT` précis attendu (trust anchor, voir plus bas). Si l'action porte
   un montant, celui-ci doit se situer sous `automatic_max_amount` (ou être
   couvert par une `APPROVAL_GRANTED` valide, non consommée, et liée par
   empreinte exacte, I15). Aucune ambiguïté n'a été rencontrée pendant la
   résolution.
2. **DENIED** — La chaîne d'autorité est entièrement connue et non ambiguë, et
   elle démontre positivement l'absence d'autorité pour la demande précise :
   révocation active et autorisée, expiration, capacité hors du périmètre exact
   accordé, montant au-delà de `approval_max_amount`, budget agrégé épuisé, ou
   grant d'approbation déjà consommé (I16) — ce dernier cas est le seul par
   lequel une question **prospective** (`authorityAt`) peut être `DENIED` dans
   la bande d'approbation. Un refus explicite et autorisé (`APPROVAL_DENIED`)
   ou une empreinte d'action différente de celle approuvée (I15) ne peuvent
   produire `DENIED` que dans le cadre **historique** d'`explainAction`, pour
   l'action précise qu'ils concernent.
3. **REQUIRES_APPROVAL** — La chaîne de délégation jusqu'au principal demandeur
   est valide et couvre la capacité demandée, le montant se situe strictement
   entre `automatic_max_amount` et `approval_max_amount`, et aucune
   `APPROVAL_GRANTED` valide et non consommée, liée par empreinte exacte, n'existe
   pour cette empreinte.
4. **UNKNOWN** — Toute autre situation : donnée manquante, chaîne partielle,
   événement en conflit, cycle détecté, profondeur dépassée (voir I10 pour le
   comptage exact), chaîne remontant à un `AGENT` sans ancre humaine, champ
   d'autorisation (`can_delegate`, seuils de montant) absent là où il est requis
   pour trancher, `schema_version` inconnue sur un événement dont la résolution
   dépend, ou toute condition non explicitement couverte par les trois cas
   ci-dessus et par le tableau exhaustif ci-dessous. `UNKNOWN` est la sortie par
   défaut du moteur : elle n'a pas besoin d'être « choisie », elle est ce qui
   reste quand aucune preuve positive de `AUTHORIZED`, `DENIED` ou
   `REQUIRES_APPROVAL` n'a été établie. Une `schema_version` inconnue ne
   contamine que les résolutions qui dépendent réellement de l'événement
   concerné (voir I1) — jamais une résolution indépendante ailleurs dans le
   graphe.

## Invariants de sécurité

Chaque invariant est formulé comme une assertion testable. Ils sont non négociables
et ne doivent être ni affaiblis ni reformulés au fil de l'implémentation.

1. **I1 — Fail-closed.** Pour toute entrée ambiguë, incomplète ou non résolue par
   les règles explicites du moteur, la sortie est `UNKNOWN`. Il n'existe dans le
   code du moteur aucun chemin où l'absence de donnée ou une branche non prévue
   aboutit à `AUTHORIZED`. Test : pour toute mutation aléatoire d'une fixture valide
   qui retire ou corrompt un champ requis, la sortie ne doit jamais être
   `AUTHORIZED`.
2. **I2 — Aucun LLM dans le chemin de décision.** La fonction de décision est pure :
   mêmes événements en entrée (même liste, même ordre de `sequence`) ⇒ même sortie,
   à chaque exécution, sans appel réseau, sans inférence, sans composant
   non-déterministe. Test : exécuter la même évaluation 1000 fois hors ligne doit
   produire un résultat strictement identique.
3. **I3 — Append-only strict.** Aucune opération du moteur ne modifie ni ne
   supprime un événement déjà accepté dans le store canonique. Toute correction
   d'erreur se fait par un nouvel événement compensatoire, jamais par mutation ou
   suppression. Un événement dont l'ingestion échoue (conflit `event_id`, collision
   d'ID métier, violation prouvée de I12/I13/I14) n'est en revanche jamais accepté
   dans le store canonique — le refuser à la porte n'est pas une mutation, c'est
   l'absence d'écriture (voir `EVENT_MODEL.md`, journal de sécurité). Test : le
   store canonique n'expose aucune opération `update`/`delete` sur un événement
   déjà persisté ; toute tentative est rejetée.
4. **I4 — Séparation stricte ordering / clock (corrigé).** Trois notions distinctes,
   jamais confondues :
   - `sequence` = ordre causal uniquement, attribué par Authority à l'ingestion,
     strictement croissant, jamais falsifiable par la source. Répond à « quel
     événement avant lequel ». C'est le seul ordre utilisé pour déterminer l'état
     du graphe « à l'instant T » et pour appliquer I7 (une révocation ne joue que
     sur les évaluations de `sequence` ≥ la sienne).
   - `authority_time` = horloge attribuée par Authority à l'ingestion, garantie
     monotone non décroissante par rapport à `sequence`. C'est la seule horloge
     utilisée pour comparer `expires_at` et pour évaluer si une délégation a
     expiré. Jamais fournie par la source, et **jamais dérivée d'`occurred_at`
     par le moteur lui-même** (correction PROMPT 3b — une première
     implémentation dérivait `authority_time` d'`occurred_at` « pour le
     déterminisme des tests » ; c'était une régression qui remettait un
     timestamp attaquable dans le chemin de décision). La valeur brute
     provient d'une **dépendance explicite** que l'appelant d'`ingestAll`
     fournit (une horloge de confiance), qu'Authority se contente de clamper
     pour garantir la monotonie ci-dessus — elle ne l'invente jamais à partir
     d'un autre champ de l'événement.
   - **Convention d'expiration (exclusive) :** `authorityTime < expires_at` ⇒
     encore valide ; `authorityTime >= expires_at` ⇒ expiré. La borne elle-même
     compte comme expirée.
   - `occurred_at` = horodatage déclaré par la source, jamais décisionnel, jamais
     utilisé pour ordonner ni pour évaluer une expiration. Conservé pour l'audit ;
     si l'écart `|authority_time − occurred_at|` dépasse un seuil nommé et explicite
     (`CLOCK_DRIFT_THRESHOLD`), `explain()` doit afficher
     `LATE_OR_BACKDATED_EVENT_OBSERVED` pour cet événement — ce signal n'affecte
     jamais `AUTHORIZED`/`DENIED`/`REQUIRES_APPROVAL`/`UNKNOWN`, il n'affecte que
     l'explication.
   - `recorded_at` = horloge d'infrastructure au moment où le store a physiquement
     vu l'événement. Diagnostic opérationnel uniquement, jamais décisionnel, jamais
     utilisé pour évaluer une expiration (ce n'est pas `authority_time`).
   `authorityAt` et `explainAction` reçoivent ce « maintenant » comme un couple
   explicite `{ atSequence, authorityTime }` (voir « Les deux opérations du
   moteur ») — jamais calculé en interne comme `max(authority_time des
   événements visibles)` : le temps qui passe ne produit pas nécessairement un
   événement, et cette dérivation ferait paraître valide pour toujours une
   délégation expirée depuis des heures, faute d'événement plus récent pour le
   révéler. Test : un événement dont `occurred_at` est antérieur à tous les
   événements déjà présents, mais qui reçoit un `sequence` et un
   `authority_time` postérieurs, ne doit jamais changer une décision déjà
   rendue pour une évaluation à une `sequence` antérieure à son insertion ;
   une expiration ne doit jamais être évaluée par comparaison à `occurred_at`
   ou `recorded_at` ; à `atSequence` et graphe identiques, deux valeurs
   d'`authorityTime` de part et d'autre d'un `expires_at` doivent produire deux
   décisions différentes.
5. **I5 — Bornage strict des sous-délégations.** Pour toute `SUBDELEGATION_CREATED`,
   sur chaque dimension indépendamment — `capabilities`, `can_delegate`,
   `expires_at`, `max_amount`, `automatic_max_amount`, `approval_max_amount`,
   `total_budget` — la valeur de l'enfant est un sous-ensemble ou une restriction
   stricte de celle du parent, en traitant toute dimension absente chez le parent
   comme illimitée (+∞) et toute dimension absente chez l'enfant alors que le
   parent la borne comme une tentative d'élargissement (donc invalide). Pour
   `total_budget` spécifiquement, la borne du parent à considérer est son **reste**
   à la `sequence` de résolution (`total_budget` déclaré moins ce qui a déjà été
   dépensé par des `ACTION_EXECUTED` autorisées rattachées à ce parent ou à l'un de
   ses descendants — voir `EVENT_MODEL.md`), pas sa valeur déclarée brute. Ce
   bornage est revérifié à chaque résolution, pas seulement à la création (voir
   note de revalidation ci-dessous). Test : toute sous-délégation qui élargit une
   seule dimension par rapport au reste actuel du parent est traitée comme
   invalide (jamais silencieusement tronquée) ; le résultat déterministe est
   `DENIED` si les deux valeurs comparées sont connues, `UNKNOWN` si l'une des deux
   ne l'est pas.
6. **I6 — Non-élargissement du mandat par approbation.** Une `APPROVAL_GRANTED` ne
   crée ni ne modifie de délégation permanente : elle couvre exactement l'action
   qui l'a demandée, identifiée par son `action_id` **et** par son
   `action_fingerprint` exact (I15), une seule fois (I16), et n'a aucun effet sur
   une action future même identique. Test : après consommation d'une
   `APPROVAL_GRANTED` par son `ACTION_EXECUTED`, une seconde `ACTION_REQUESTED`
   identique ne peut pas être `AUTHORIZED` sur la base de cette même approbation.
7. **I7 — Propagation de la révocation.** Une `DELEGATION_REVOKED` **autorisée**
   (I13) invalide, à partir de son `sequence`, toute délégation et sous-délégation
   qui dépend exclusivement de la délégation révoquée comme unique chaîne
   d'autorité. Un descendant disposant d'une seconde chaîne d'autorité indépendante
   et par ailleurs valide reste `AUTHORIZED` via cette seconde chaîne — chaque
   chaîne retenue devant être démontrée intégralement valide sur toute sa longueur
   (voir « règle multi-chemin » ci-dessous ; « il existe un second chemin » seul ne
   suffit jamais). Une `DELEGATION_REVOKED` **non autorisée** est sans effet sur la
   décision (voir I13). Test : révoquer une délégation parent via un événement
   autorisé fait passer tous ses descendants mono-chaînés à `DENIED` (chaîne
   connue, preuve positive d'absence d'autorité) sans affecter un descendant
   multi-chaîné valide par ailleurs ; une révocation non autorisée ne change
   aucune décision.
8. **I8 — Idempotence des événements (déduplication à l'ingestion).** Deux
   événements portant le même `event_id` et un contenu strictement identique ne
   produisent qu'un seul effet sur l'état (le second est un no-op silencieux côté
   état canonique). Deux événements portant le même `event_id` avec un contenu
   différent ne sont jamais tous deux acceptés dans le store canonique :
   l'ingestion du second échoue et retourne `UNKNOWN` **comme réponse directe à
   cette tentative d'ingestion** ; l'événement rejeté n'entre jamais dans le store
   canonique et ne peut donc affecter aucune évaluation `authorityAt()` future
   (voir séparation store canonique / journal de sécurité). Test : rejouer le même
   événement N fois ne change pas l'état ; injecter un `event_id` dupliqué avec un
   payload différent doit produire `UNKNOWN` pour l'appel d'ingestion, jamais un
   écrasement silencieux, et ne doit avoir aucun effet sur les résolutions
   ultérieures portant sur d'autres event_id.
9. **I9 — Capacités exactes uniquement (V0).** Une capacité est une paire exacte
   `(resource, action)`. Aucun caractère générique, aucune expression régulière,
   aucun héritage implicite de scope n'est interprété comme couvrant une capacité
   plus spécifique. Test : une capacité demandée qui n'a pas de correspondance
   exacte, caractère pour caractère, dans une chaîne par ailleurs entièrement
   connue est `DENIED` ; si la chaîne elle-même est incomplète, c'est `UNKNOWN`
   (jamais `AUTHORIZED` par correspondance floue dans les deux cas).
10. **I10 — Protection cycles et profondeur.** Le moteur applique une limite de
    profondeur de chaîne explicite et configurée : `MAX_CHAIN_DEPTH = 32`.
    Cette limite est comptée en **arêtes de délégation traversées** (chaque
    `DELEGATION_CREATED`/`SUBDELEGATION_CREATED` emprunté en remontant vers la
    racine compte pour une arête), **jamais en nœuds ni en principals
    distincts** : un même principal peut apparaître plusieurs fois le long
    d'une chaîne sans changer le compte, et c'est le nombre de maillons que le
    resolver doit parcourir et revalider (I5, I12) — pas le nombre d'identités
    en présence — qui détermine le coût de résolution. C'est une limite de
    résolution d'**un chemin**, jamais un motif pour faire basculer tout le
    graphe en `UNKNOWN` : une branche qui dépasse la limite ne doit jamais
    empoisonner une chaîne indépendante et valide vers le même agent (règle
    multi-chemin, ci-dessous). Toute chaîne dont la résolution dépasserait 32
    arêtes, ou dans laquelle un cycle de délégation est détecté, retourne
    `UNKNOWN` avec le code `MAX_CHAIN_DEPTH_EXCEEDED` (profondeur) ou
    `C18_CYCLE_DETECTED` (cycle). Test : une chaîne d'exactement 32 arêtes est
    résolue normalement (pas de traitement spécial à la limite exacte) ; une
    chaîne de 33 arêtes retourne `UNKNOWN`/`MAX_CHAIN_DEPTH_EXCEEDED` ; un
    graphe construit avec un cycle explicite retourne `UNKNOWN` sans boucle
    infinie ni dépassement de pile ; une branche de 33 arêtes coexistant avec
    une chaîne indépendante de 3 arêtes vers le même agent ne doit dégrader
    que la première, jamais la seconde.
11. **I11 — Aucun secret ni PII dans le graphe.** Tous les `principal_id` sont des
    identifiants opaques sans structure interprétable. Aucun champ d'événement ne
    transporte de secret ni de donnée personnelle identifiante. La détection de
    motifs interdits à l'ingestion (par exemple un `principal_id` qui prend la
    forme reconnaissable d'une adresse email) **rejette des formes explicitement
    prohibées** ; elle ne garantit en aucun cas l'**absence** de toute PII dans
    le graphe — l'absence de détection n'est pas une preuve d'absence, cohérent
    avec I17 (honnêteté du niveau d'assurance) : `explain()` ne doit jamais
    laisser entendre que le graphe est certifié exempt de PII, seulement que les
    formes reconnues ont été refusées à la porte. Test : un scan des schémas
    d'événements et des fixtures ne doit trouver aucun champ correspondant à un
    pattern d'email, de nom complet ou de secret ; un test d'ingestion doit
    montrer qu'au moins une forme reconnue (email) est rejetée, sans jamais
    prétendre que cette liste est exhaustive.
12. **I12 — Droit de déléguer.** Chaque délégation (`DELEGATION_CREATED` ou
    `SUBDELEGATION_CREATED`) porte un booléen explicite `can_delegate`, dont
    l'absence rend toute résolution qui en dépend `UNKNOWN` (jamais interprétée
    comme `true` ni comme `false` par défaut). Une `SUBDELEGATION_CREATED` n'est
    valide que si (a) son `principal_id` émetteur est exactement le
    `grantee_principal_id` de la délégation parente référencée, et (b) cette
    délégation parente porte `can_delegate: true`. Une délégation, par
    construction, confère toujours le droit d'exécuter les capacités qu'elle liste
    (`can_execute` est implicite à la détention d'une délégation valide) — elle ne
    confère le droit de sous-déléguer que si `can_delegate: true` est explicite.
    Test : une `SUBDELEGATION_CREATED` dont l'émetteur diffère du grantee du parent,
    ou dont le parent porte `can_delegate: false`, est `DENIED` (fait connu) ; si
    `can_delegate` est absent du parent, c'est `UNKNOWN`.
13. **I13 — Droit de révoquer.** Une `DELEGATION_REVOKED` n'est autorisée que si son
    `principal_id` émetteur est soit (a) le `grantor_principal_id` de la
    délégation ciblée, soit (b) le `grantor_principal_id` de la délégation racine
    (`parent_delegation_id: null`) au sommet de la chaîne à laquelle appartient la
    délégation ciblée. Toute autre émission de `DELEGATION_REVOKED` est **ignorée
    pour la décision** (elle n'invalide rien) et journalisée comme tentative non
    autorisée dans le journal de sécurité — ceci afin qu'un tiers ne puisse pas
    utiliser I7 comme arme de déni de service contre une chaîne légitime. Test :
    une révocation émise par un principal autre que le grantor direct ou la racine
    de chaîne ne doit avoir strictement aucun effet sur `authorityAt()`.
14. **I14 — Droit de décider une approbation.** Une `APPROVAL_GRANTED` ou une
    `APPROVAL_DENIED` n'est autorisée que si son `principal_id` émetteur est
    exactement le `grantor_principal_id` de la délégation dont les seuils de
    montant ont produit `REQUIRES_APPROVAL` pour l'action concernée. Le
    `requested_from_principal_id` porté par l'`APPROVAL_REQUESTED` correspondante
    ne confère aucune autorité — il est purement informatif (routage) — sinon
    l'attaquant choisirait son propre approbateur. Une décision d'approbation émise
    par un émetteur non habilité est ignorée pour la décision et journalisée comme
    tentative non autorisée. Test : une `APPROVAL_GRANTED` dont l'émetteur diffère
    du grantor habilité ne doit jamais faire passer une action de
    `REQUIRES_APPROVAL` à `AUTHORIZED`.
15. **I15 — Binding par empreinte d'action.** Toute décision d'approbation porte
    implicitement sur l'empreinte canonique (`action_fingerprint`, voir
    `EVENT_MODEL.md`) de l'`ACTION_REQUESTED` qu'elle vise, calculée à partir de
    `capability_requested.resource`, `capability_requested.action`,
    `parameters.amount` et `parameters.recipient`, dans cet ordre exact. Une
    `ACTION_EXECUTED` dont l'`action_fingerprint` déclaré diffère de l'empreinte de
    l'`ACTION_REQUESTED` de même `action_id` est `DENIED`, même si `action_id` et
    `approval_id` correspondent par ailleurs. Test : faire varier `parameters` (le
    montant ou le destinataire) entre l'`ACTION_REQUESTED` approuvée et
    l'`ACTION_EXECUTED` doit produire `DENIED`, jamais `AUTHORIZED` par simple
    correspondance d'`action_id`.
16. **I16 — Consommation à usage unique.** Un `approval_id` donné ne peut être
    consommé que par une seule `ACTION_EXECUTED`, quel que soit le nombre
    d'événements distincts (par `event_id`) qui tentent de le consommer. En cas de
    plusieurs `ACTION_EXECUTED` référençant le même `approval_id`, seule celle de
    plus petit `sequence` est valide ; toute autre est `DENIED`. I8 déduplique des
    événements identiques ; I16 déduplique un effet métier, y compris entre
    événements distincts et non conflictuels au sens I8. Test : deux
    `ACTION_EXECUTED` d'`event_id` différents, référençant le même `approval_id`
    valide, ne doivent jamais produire deux `AUTHORIZED`.
17. **I17 — Honnêteté du niveau d'assurance.** V0 ne vérifie ni signature ni
    identité cryptographique : chaque événement porte un `assurance_level` figé à
    `ASSERTED_UNVERIFIED`. `explain()` ne doit jamais affirmer qu'un fait a été
    *prouvé* ; il doit formuler ses conclusions comme « le journal contient un
    événement affirmant que X a accordé Y », jamais « X a prouvé qu'il a accordé
    Y ». Test : un audit du texte produit par `explain()` ne doit contenir aucune
    formulation impliquant une preuve cryptographique ou une vérification
    d'identité forte.
18. **I18 — `decision_sequence` ne peut jamais excéder sa propre `sequence`
    (PROMPT 6a, finding #4).** `decision_sequence`, porté par une
    `ACTION_EXECUTED`, est un champ auto-déclaré par l'émetteur de
    l'événement — exactement comme `occurred_at` (I4) — et rien à l'ingestion
    ne le contraint contre l'ordre causal réel : le moteur doit donc le
    contraindre lui-même, à la résolution. Une `sequence` n'existe qu'une fois
    l'événement qui la porte accepté dans le store canonique ; un point de
    décision ne peut donc jamais se situer à une `sequence` postérieure **ou
    égale** à celle de l'`ACTION_EXECUTED` qui le cite — un `decision_sequence`
    égal à la `sequence` de sa propre exécution n'a pas plus de sens causal
    qu'un `decision_sequence` strictement futur, puisqu'un événement ne peut
    jamais servir de preuve à lui-même. Formellement, pour toute
    `ACTION_EXECUTED` de `sequence` S : `decision_sequence < S` est requis.
    Une violation de cette contrainte n'est jamais une preuve positive
    d'absence d'autorité (ce n'est pas ce que le maillon *dit*, c'est que la
    question elle-même n'a pas de sens causal) : la sortie est `UNKNOWN`,
    jamais `DENIED` — tranché, pas « selon le contexte » — cohérent avec I1
    (une question mal formée bloque, elle ne tranche pas sur le fond à sa
    place). Cette règle s'applique à `execution.authorityAtDecision`
    uniquement (`explainAction`) ; elle est sans objet pour `authorityAt`, qui
    ne connaît aucun `decision_sequence`. Test : une `ACTION_EXECUTED` de
    `sequence` S dont `decision_sequence >= S` doit produire `UNKNOWN` pour
    `execution.authorityAtDecision`, même si une autorité par ailleurs valide
    existe réellement à ce `decision_sequence` prétendu (i.e. même si
    l'attaque, menée un peu différemment, aurait pu réussir) — le rejet porte
    sur la forme causale de la citation, pas sur le contenu de l'autorité
    citée.
19. **I19 — Légitimité causale des références « revendication » par ID
    (PROMPT 6b, racine commune — portée révisée après vérification empirique,
    voir note ci-dessous).** I18 n'était qu'une instance d'un motif général :
    plusieurs champs d'événement citent un autre événement par un
    identifiant métier, et le resolver ne vérifiait jusqu'ici cette citation
    que par correspondance d'ID, jamais par ordre causal. La règle, formulée
    une fois : **une référence par ID n'est légitime que si l'événement cité
    existe dans le store canonique et que sa `sequence` n'est jamais
    strictement postérieure à celle de l'événement citant** (égalité
    tolérée — voir « Note sur l'égalité de séquence » ci-dessous ; c'est
    volontairement plus permissif que I18, qui interdit l'égalité pour la
    raison inverse : I18 compare un champ d'un événement à la `sequence` de
    ce **même** événement, ce qui rend l'égalité intrinsèquement absurde,
    alors qu'I19 compare deux événements **distincts**).

    Champs concernés, et **portée réelle** de la règle pour chacun (toutes ne
    reçoivent pas le même traitement — voir la distinction avec A5
    ci-dessous, qui explique pourquoi) :
    - `APPROVAL_GRANTED.action_id` et `APPROVAL_GRANTED.approval_id` ;
    - `APPROVAL_DENIED.action_id` et `APPROVAL_DENIED.approval_id` ;
      — pour ces deux événements, I19 s'applique pleinement : existence **et**
      ordre causal.
    - `APPROVAL_REQUESTED.action_id` — couvert par la même règle en
      principe ; V0 n'a aujourd'hui aucun chemin de décision qui en dépend
      (champ purement informatif — routage), donc rien à appliquer
      concrètement pour l'instant.
    - `ACTION_EXECUTED.authority_chain_ref` (chaque `delegation_id`/
      `approval_id` qui y figure) — couvert en principe (un maillon cité ne
      peut pas exister causalement après l'exécution qui prétend s'appuyer
      dessus) ; non appliqué en code dans ce passage faute de nécessité
      démontrée (voir « Portée restreinte » ci-dessous).
    - `SUBDELEGATION_CREATED.parent_delegation_id` — **exclu de la moitié
      « ordre causal » d'I19.** Voir « Distinction avec la livraison
      hors-ordre » ci-dessous : ce champ reste gouverné uniquement par la
      moitié « existence » (déjà en place avant I19, via C10), jamais par
      l'ordre des `sequence` entre parent et enfant.

    **Distinction avec la livraison hors-ordre (A5, déjà traitée) — et
    pourquoi `parent_delegation_id` n'est pas ordonné par I19.** I19 ne porte
    que sur la relation causale une fois les **deux** événements présents
    dans le store — jamais sur l'absence temporaire de l'un des deux. Un
    événement dont le prédécesseur référencé n'est pas encore arrivé au
    moment de l'ingestion (A5) est une situation légitime, déjà couverte (le
    store canonique l'accepte sans jugement d'autorité définitif, et la
    résolution reste `UNKNOWN` tant que le prédécesseur manque) — ce n'est
    **pas** une violation d'I19. Mais A5, pour les délégations
    spécifiquement, va plus loin que « l'absence est temporaire » : une fois
    le parent *arrivé*, peu importe l'ordre relatif de `sequence` dans
    lequel parent et enfant ont été **ingérés** — seule compte la question
    « les deux existent-ils à la `sequence` d'évaluation ? ». C'est un choix
    de conception déjà spécifié et déjà testé (le parent peut porter une
    `sequence` supérieure à celle de l'enfant qui le référence, et la chaîne
    devient pleinement valide dès que les deux sont visibles), parce
    qu'une chaîne de délégation est évaluée comme un **instantané** de
    graphe à `atSequence`, jamais comme la preuve qu'une revendication
    ponctuelle s'appuyait sur une preuve déjà là au moment précis de son
    émission. C'est cette seconde catégorie de champ — une revendication sur
    un instant précis (« je réponds, maintenant, à cette requête
    d'approbation déjà déposée » ; « j'ai exécuté en m'appuyant sur cette
    approbation déjà accordée ») — qu'I19 contraint par l'ordre causal.
    `parent_delegation_id` n'en fait pas partie : c'est un pointeur
    structurel dans un graphe résolu par instantané, pas une revendication
    temporelle. Le confondre avec les deux premiers casserait A5, qui reste
    un comportement voulu, pas une faille.

    **Note sur l'égalité de séquence.** Le système d'ingestion réel
    (`src/engine/ingest.ts`) attribue une `sequence` strictement croissante
    et unique à chaque événement accepté, un par un : deux événements
    distincts ne peuvent jamais, en pratique, partager la même `sequence`.
    Deux événements de test construits directement comme `AuthorityEvent`
    déjà « ingérés » (en dehors de toute ingestion réelle) peuvent en
    revanche partager une valeur de `sequence` par convention d'écriture du
    test (par exemple pour représenter « la même étape logique »). I19
    tolère cette égalité (elle ne peut de toute façon jamais survenir via une
    ingestion réelle, donc la tolérer n'ouvre aucune brèche observable) ;
    seule une `sequence` **strictement supérieure** — un événement qui
    n'existait, de façon démontrable, pas encore — constitue une violation.

    **Sortie, tranchée.** Une référence violant I19 est traitée exactement
    **comme si l'événement cité n'existait pas** — jamais comme s'il existait
    avec un sens plus permissif. Ce n'est pas une nouvelle valeur de sortie
    ad hoc par champ : c'est l'application directe de la sémantique déjà
    spécifiée pour « cet événement n'existe pas », propre à chaque champ
    concerné, et donc déjà déterministe : pour `APPROVAL_GRANTED`/
    `APPROVAL_DENIED`, la décision d'approbation est ignorée, exactement
    comme si elle n'avait jamais été émise (voir C16 pour I14, même
    traitement) — une décision monétaire dans la bande d'approbation sans
    aucune décision d'approbation valide et non consommée reste
    `REQUIRES_APPROVAL` (C4) ; elle ne devient jamais `AUTHORIZED` sur la
    foi d'une citation causalement impossible.

    Test : une `APPROVAL_GRANTED` (ou `APPROVAL_DENIED`) dont l'`approval_id`
    ne correspond à aucune `APPROVAL_REQUESTED` présente et causalement non
    postérieure ne doit jamais faire basculer une question en `AUTHORIZED`
    (ou en `DENIED` pour un refus) sur la seule foi de cette citation ; une
    `SUBDELEGATION_CREATED` dont le parent arrive, dans le store, à une
    `sequence` supérieure à celle de l'enfant qui le référence doit rester
    résolue normalement dès que les deux sont visibles (A5 — non concerné par
    la moitié « ordre » d'I19).
20. **I20 — Qui peut débiter un `total_budget` (PROMPT 6b, finding #2).**
    `remainingBudget` (`src/engine/evaluateConstraints.ts`) somme, pour une
    délégation D bornée par `total_budget`, tous les `ACTION_EXECUTED`
    visibles dont `authority_chain_ref` passe par D — mais jusqu'ici sans
    jamais vérifier que l'exécution comptabilisée avait un rapport
    démontrable avec l'identité qui détenait effectivement cette chaîne.
    N'importe qui peut soumettre une `ACTION_EXECUTED` citant la délégation
    d'un tiers dans son `authority_chain_ref` — I3 l'accepte sans jugement
    d'autorité (l'ingestion ne valide pas l'autorité d'une exécution, voir
    I18) — et jusqu'ici cette écriture, une fois dans le store, débitait le
    budget de ce tiers, sans qu'aucune décision `AUTHORIZED` n'ait jamais été
    démontrée pour elle : un déni de service par épuisement de budget contre
    une chaîne par ailleurs parfaitement légitime.

    **Pourquoi pas une re-résolution complète (risque de récursion).**
    `remainingBudget` est appelé depuis `evaluateConstraints`
    (`budgetExceeded`) et depuis `validateChain` (`totalBudgetBoundOk`),
    tous deux **sur le chemin de décision** de `resolveAuthority` lui-même.
    Exiger, pour chaque `ACTION_EXECUTED` sommée, une preuve complète
    qu'elle *aurait été* `AUTHORIZED` à son `decision_sequence` obligerait
    `remainingBudget` à rappeler `resolveAuthority` pour chacune — et si la
    chaîne de CETTE exécution passe elle-même par une délégation bornée par
    `total_budget`, cet appel rappellerait `remainingBudget`, qui
    rappellerait potentiellement `resolveAuthority`, etc. : une dépendance
    circulaire, sans garantie de terminaison comparable à I10 (I10 borne la
    profondeur d'**une** chaîne de délégation ; rien ne borne ici le nombre
    d'exécutions historiques imbriquées les unes dans les autres). I20 exclut
    délibérément cette voie : il ne redemande **jamais** au resolver si une
    exécution passée aurait été autorisée.

    **La règle, non récursive.** Une `ACTION_EXECUTED` ne compte contre le
    `total_budget` d'aucune délégation de son `authority_chain_ref` — ni la
    délégation directement invoquée, ni un ancêtre borné plus haut dans la
    même chaîne — sauf si les deux conditions suivantes, purement
    structurelles et déjà immuables dans le store, sont satisfaites :
    - `executed_by_principal_id` de l'`ACTION_EXECUTED` est exactement
      `requesting_principal_id` de l'`ACTION_REQUESTED` de même `action_id`
      (celui qui a exécuté est celui qui avait demandé — pas un tiers qui
      s'attribue l'exécution d'une demande d'autrui) ;
    - le dernier maillon de type délégation dans `authority_chain_ref` (le
      maillon terminal, celui que l'exécutant prétend avoir exercé) a pour
      `grantee_principal_id` exactement `executed_by_principal_id` (la
      chaîne citée se termine réellement chez l'exécutant, pas chez un
      tiers dont l'exécutant se contente de recopier l'identifiant de
      délégation).

    Ces deux vérifications ne consultent que des champs déjà présents et
    immuables sur des événements déjà ingérés (I3) — aucun appel à
    `resolveAuthority`/`validateChain`, aucune récursion, même coût
    asymptotique que les lectures déjà existantes de `remainingBudget`.

    **Ce que I20 ne garantit pas.** Ces deux conditions sont nécessaires,
    pas suffisantes : elles ne revalident ni l'expiration, ni la révocation,
    ni la couverture de capacité, ni les seuils de montant de la chaîne
    citée — seule une résolution complète le ferait, et c'est précisément
    ce qu'I20 refuse de redemander pour éviter la récursion ci-dessus. I20
    ferme uniquement le vecteur « un tiers sans aucun rapport avec la
    chaîne cite le `delegation_id` d'autrui » ; une exécution qui échoue
    l'une de ces deux vérifications est exclue du débit, exactement comme
    si elle n'apparaissait pas dans `authority_chain_ref` — ce n'est pas
    une nouvelle valeur de sortie, c'est un décompte corrigé qui alimente
    C1–C9 normalement.

    **Cohérence avec A24 (TOCTOU budgétaire) — I20 ne change rien à A24.**
    A24 documente que deux décisions individuellement `AUTHORIZED`, prises
    par le même titulaire légitime, peuvent ensemble dépasser `total_budget`
    faute de réservation : c'est une question de **moment** (deux décisions
    honnêtes, jamais réconciliées avant exécution). I20 est une question
    d'**identité** (une exécution malhonnête, jamais légitimement rattachée
    à la chaîne qu'elle cite). Les deux conditions d'I20 sont trivialement
    satisfaites dans le scénario A24 (le même principal légitime demande et
    exécute, via sa propre délégation) : I20 ne bloque, ne détecte, ni ne
    corrige le dépassement A24, qui reste un dépassement honnête entre deux
    exécutions par ailleurs chacune conformes à I20. Les deux invariants
    portent sur des axes indépendants et ne se contredisent pas.

    Test : une `ACTION_EXECUTED` dont l'`executed_by_principal_id` diffère
    du `requesting_principal_id` de l'`ACTION_REQUESTED` qu'elle cite, ou
    dont le maillon terminal de `authority_chain_ref` a un
    `grantee_principal_id` différent de son propre `executed_by_principal_id`,
    ne doit jamais réduire le `total_budget` restant d'aucune délégation de
    cette chaîne — une requête par ailleurs légitime et dans la bande
    automatique de son titulaire réel reste `AUTHORIZED`.

## Règles d'application complémentaires

Ces règles ne sont pas des invariants numérotés supplémentaires : elles précisent
comment les invariants ci-dessus s'appliquent concrètement, pour éliminer toute
zone grise.

- **Trust anchor (ancre racine).** Chaque `DELEGATION_CREATED` racine
  (`parent_delegation_id: null`) porte un champ `grantor_type` valant
  `HUMAN_ROOT` ou `AGENT`. `AUTHORIZED` exige que la chaîne remonte à une racine
  dont `grantor_type = HUMAN_ROOT`. Une chaîne dont la racine est `AGENT` ne peut
  pas être complétée plus haut (`parent_delegation_id` racine est toujours `null`
  par construction) : c'est une chaîne dont la provenance humaine ne peut jamais
  être établie ⇒ `UNKNOWN`, jamais `DENIED` (on ne prouve pas l'absence
  d'autorité, on constate l'absence de preuve de sa présence — cf. I1). Pour
  `authorityAt`, ce `HUMAN_ROOT` doit en outre être exactement celui asserté par
  `principalId` dans la requête : une racine `HUMAN_ROOT` valide mais différente
  de `principalId` est `DENIED` pour cette requête précise (preuve positive que
  cette paire `(agentId, principalId)` n'a pas autorité), pas `UNKNOWN`.
- **Revalidation systématique (I5, I12, I13, I14).** Le resolver ne suppose
  jamais que l'ingestion a correctement validé un événement : à chaque
  `authorityAt()`, il réévalue lui-même I5, I12, I13 et I14 à partir du seul
  contenu du store canonique jusqu'à la `sequence` d'évaluation. L'ingestion peut
  rejeter un événement dont la violation est prouvable avec l'état canonique
  connu au moment de l'ingestion (il n'entre alors jamais dans le store
  canonique — voir séparation ci-dessous) ; mais un événement structurellement
  valide qui référence un maillon pas encore connu à l'ingestion (livraison
  hors-ordre, A5) entre dans le store canonique sans jugement d'autorité définitif,
  et c'est la résolution qui tranche, avec toute l'information disponible à sa
  propre `sequence`.
- **Séparation store canonique / journal de sécurité (précise I3 et I8).**
  `authorityAt()` ne lit jamais que le store canonique. Un événement dont
  l'ingestion échoue de façon prouvée (conflit `event_id` — I8 ; collision d'ID
  métier ; violation prouvée de I12/I13/I14 avec l'état canonique déjà connu)
  n'est **jamais** écrit dans le store canonique : il est écrit uniquement dans le
  journal de sécurité (voir `EVENT_MODEL.md`), qui n'est jamais consulté par
  `authorityAt()`. Ceci retire la promesse antérieure et incohérente selon
  laquelle « toute évaluation impliquant cet `event_id` retourne `UNKNOWN` » de
  façon persistante : seule la réponse synchrone à la tentative d'ingestion en
  conflit est `UNKNOWN` ; les résolutions futures, qui ne voient jamais l'événement
  rejeté, n'ont aucune raison d'être `UNKNOWN` à cause de lui.
- **`ingestAll` est un helper de test sans état, pas le store d'événements**
  (PROMPT 3b). Il démontre le comportement des frontières d'ingestion (I8,
  unicité des ID métier, I12/I13/I14, rejet de schéma/PII) un lot à la fois,
  en repartant toujours de `sequence = 1` — ce n'est pas la persistance
  visée par l'architecture. L'`EventStore` d'un prompt futur possédera : le
  compteur de `sequence` suivant, en continu à travers les appends
  successifs (un store ayant déjà accepté les séquences 1..50 numérote un
  nouvel append 51..80, jamais un redémarrage à 1) ; `recorded_at` à partir
  de sa propre horloge d'infrastructure ; `authority_time` à partir de la
  même dépendance d'horloge de confiance, appliquée sur toute la durée de
  vie du store plutôt qu'un seul lot ; l'unicité d'`event_id` et des ID
  métier vérifiée contre l'historique complet, pas seulement le lot courant.
  Voir `src/engine/ingest.ts` pour le contrat détaillé de cette dépendance
  d'horloge.
- **Règle multi-chemin.** Si plusieurs chaînes de délégation distinctes mènent au
  même principal demandeur, il suffit qu'**une seule** d'entre elles soit
  intégralement valide (chaque maillon autorisé, non expiré, non révoqué, capacité
  couverte, profondeur respectée) pour que la décision soit `AUTHORIZED` — la
  présence d'autres chaînes corrompues, révoquées, cycliques ou trop profondes
  n'affecte pas ce résultat. Ceci empêche qu'un attaquant neutralise une autorité
  légitime en injectant une chaîne parasite pour déclencher `UNKNOWN` par
  fail-closed. En contrepartie, aucune chaîne n'est jamais retenue sur la base de
  « il existe probablement un autre chemin » : la chaîne retenue doit être
  démontrée valide sur toute sa longueur, avec les mêmes règles que si elle était
  unique.
- **Sémantique de `total_budget` (non-dépassement, pas réservation).** Propriété
  visée : à aucune `sequence` S, la somme des `parameters.amount` de toutes les
  `ACTION_EXECUTED` imputables à une délégation D et à tous ses descendants
  (celles dont `authority_chain_ref` passe par D) ne dépasse `D.total_budget`,
  quand `D.total_budget` est déclaré. Chaque exécution est comptabilisée contre
  **tous** les ancêtres bornés de sa chaîne qui déclarent un `total_budget` — pas
  seulement la délégation terminale directement invoquée par l'`ACTION_REQUESTED`.
  V0 ne fournit **aucune garantie de réservation de capacité** : deux évaluations
  concurrentes portant sur le même état canonique, avant qu'aucune des deux
  exécutions ne soit enregistrée, peuvent chacune être individuellement
  `AUTHORIZED` et dépasser `total_budget` une fois combinées (TOCTOU budgétaire,
  voir A24 dans `THREAT_MODEL.md`). Ce que V0 garantit, c'est que `reste(D, S)`
  reste toujours calculable de façon déterministe et honnête à partir du seul
  store canonique — y compris négatif (dépassement constaté) — et que ce
  dépassement, une fois constaté, est rapporté par `explain()` sans être
  dissimulé ni les décisions passées réécrites (I3) : V0 identifie l'incohérence
  après ingestion des exécutions, il ne l'empêche pas avant.
- **Débit budgétaire et fixité de `authority_chain_ref`.** Le resolver peut
  découvrir plusieurs chaînes valides vers le même principal (règle multi-chemin,
  ci-dessus), mais une `ACTION_EXECUTED` référence une chaîne concrète et unique
  dans `authority_chain_ref`, entièrement valide à `decision_sequence`. C'est
  exclusivement cette chaîne, et les ancêtres bornés qu'elle contient, qui sont
  débités pour `total_budget`. `authority_chain_ref` est fixé au moment de
  l'exécution et n'est jamais recalculé ni réattribué après coup (I3) : un agent
  ne peut pas invoquer une autre chaîne valide vers le même principal au seul
  motif qu'elle disposerait de plus de budget restant.
- **Portée d'un refus (`APPROVAL_DENIED`).** Un refus vise une `APPROVAL_REQUESTED`
  précise, identifiée par son `approval_id` — jamais un `action_fingerprint` de
  façon permanente. Une nouvelle `APPROVAL_REQUESTED` portant un `approval_id`
  différent, même pour une action de `action_fingerprint` identique (même
  capacité, même montant, même destinataire), est recevable et s'évalue
  indépendamment (nouvelle instance de C4). `action_fingerprint` n'est jamais une
  liste noire permanente : en faire une reviendrait à inventer une politique
  métier (durée de blocage, portée, exceptions) que V0 ne spécifie pas. C'est
  précisément pour cette raison qu'`authorityAt` (prospective, sans
  `actionId`) ne consulte jamais `APPROVAL_DENIED` : un refus n'a de sens que
  rattaché à l'action précise qu'il concerne, et seule `explainAction` a cette
  action en main.
- **Révocation ≠ invalidation.** `DELEGATION_REVOKED` signifie « cette délégation
  était valide et cesse de l'être à partir de cette `sequence` ». Elle ne signifie
  jamais « cette délégation n'aurait jamais dû exister » (erreur d'émission,
  compromission au moment de la création). Ce second cas — invalidation
  rétroactive d'un événement erroné dès l'origine — n'est **pas implémenté en V0**
  et nécessiterait un type d'événement distinct (`EVENT_INVALIDATED`, extension
  future non spécifiée ici). V0 ne prétend traiter que la révocation.

## Tableau exhaustif condition → sortie

Aucune condition ci-dessous ne produit « DENIED ou UNKNOWN selon le contexte » :
chaque ligne a une sortie déterministe unique. Sauf mention contraire, chaque
ligne s'applique à `authorityAt` (question prospective sur une empreinte). C5
et C6 sont par nature des questions sur une action précise déjà demandée et
relèvent d'`explainAction` — leur `DENIED` s'entend comme `currentAuthority`
ou `execution.authorityAtDecision` de cette action, jamais comme une réponse
qu'`authorityAt` pourrait produire à partir de la seule empreinte (un
`APPROVAL_DENIED` ne fait jamais basculer une question prospective en
`DENIED` : voir « `authorityAt` — question prospective » ci-dessus).

| # | Condition | Sortie |
|---|---|---|
| C1 | Chaîne complète, tous maillons autorisés (I12/I13/I14), non expirée (`authority_time`), non révoquée par une révocation autorisée, capacité couverte exactement, racine `HUMAN_ROOT` précise attendue, pas de montant impliqué | `AUTHORIZED` |
| C2 | Comme C1, avec montant ≤ `automatic_max_amount` du maillon invoqué | `AUTHORIZED` |
| C3 | Comme C1, montant entre `automatic_max_amount` (exclu) et `approval_max_amount` (inclus), il existe une `APPROVAL_GRANTED` valide (I14) dont l'empreinte correspond exactement (I15) à `(capability, parameters)` et qui n'est pas déjà consommée (I16) | `AUTHORIZED` |
| C4 | Comme C3, mais aucune `APPROVAL_GRANTED` valide et non consommée n'existe pour cette empreinte (qu'il y ait eu ou non, par ailleurs, un `APPROVAL_DENIED` pour une action différente portant la même empreinte — voir « eternal blacklist ») | `REQUIRES_APPROVAL` |
| C5 *(explainAction)* | L'action précise expliquée a reçu, pour sa propre `APPROVAL_REQUESTED`, un `APPROVAL_DENIED` valide (I14) et aucune `APPROVAL_GRANTED` valide et non consommée ne couvre par ailleurs son empreinte | `DENIED` (pour `currentAuthority` de cette action) |
| C6 *(explainAction)* | L'`ACTION_EXECUTED` de l'action expliquée porte un `action_fingerprint` différent de l'empreinte immuable de son `ACTION_REQUESTED` (I15) | `DENIED` (pour `execution.authorityAtDecision`, quelle que soit par ailleurs l'autorité pour l'empreinte réellement exécutée) |
| C7 | Une `APPROVAL_GRANTED` valide et d'empreinte correcte existe pour `(capability, parameters)`, mais elle est déjà consommée par une `ACTION_EXECUTED` de `sequence` inférieure ou égale (I16) — et aucune autre approbation valide et non consommée ne couvre la même empreinte | `DENIED` |
| C8 | Montant > `approval_max_amount` du maillon invoqué | `DENIED` |
| C9 | `total_budget` déclaré sur un ou plusieurs ancêtres bornés de la chaîne invoquée (pas seulement la délégation terminale) et montant demandé > reste disponible d'au moins un de ces ancêtres, calculé indépendamment pour chacun, à la `sequence` d'évaluation | `DENIED` |
| C10 | Un maillon de la chaîne référence un `delegation_id` absent du store canonique à la `sequence` d'évaluation | `UNKNOWN` |
| C11 | Chaîne complète et connue, mais aucune capacité de la chaîne ne correspond exactement à la capacité demandée | `DENIED` |
| C12 | `DELEGATION_REVOKED` autorisée (I13) avec `sequence` ≤ celle de l'évaluation, ciblant un maillon dont dépend exclusivement la chaîne | `DENIED` |
| C13 | `DELEGATION_REVOKED` dont l'émetteur n'est ni le grantor direct ni la racine de chaîne (I13 non satisfait) | Sans effet — la chaîne est évaluée comme si cette révocation n'existait pas |
| C14 | `SUBDELEGATION_CREATED` dont l'émetteur ≠ grantee du parent, ou parent avec `can_delegate: false` connu (I12) | `DENIED` |
| C15 | `SUBDELEGATION_CREATED` dont le parent ne porte pas de champ `can_delegate` (absent) | `UNKNOWN` |
| C16 | `APPROVAL_GRANTED`/`APPROVAL_DENIED` dont l'émetteur ≠ grantor habilité (I14) | Sans effet — traité comme si aucune décision d'approbation n'existait |
| C17 | Racine de chaîne (`parent_delegation_id: null`) avec `grantor_type: AGENT` | `UNKNOWN` |
| C18 | Cycle détecté dans la chaîne de `delegation_id` | `UNKNOWN` (`C18_CYCLE_DETECTED`) |
| C19 | Profondeur de chaîne > `MAX_CHAIN_DEPTH` (32 arêtes de délégation, voir I10) | `UNKNOWN` (`MAX_CHAIN_DEPTH_EXCEEDED`) — une chaîne d'exactement 32 arêtes n'est **pas** concernée par cette ligne et se résout normalement |
| C20 | Conflit d'`event_id` détecté à l'ingestion (I8) | `UNKNOWN` en réponse directe à cette tentative d'ingestion ; sans effet sur les résolutions ultérieures |
| C21 | Collision d'ID métier (`delegation_id`/`action_id`/`approval_id` déjà utilisé par un contenu différent) | L'événement en collision est rejeté à l'ingestion ; `UNKNOWN` en réponse à cette tentative, sans effet sur les résolutions ultérieures |
| C22 | Type de contrainte inconnu ou non reconnu présent dans un payload de délégation, ou `schema_version` inconnue portée par un événement | `UNKNOWN`, mais **seulement** pour toute résolution qui dépend réellement de cet événement précis — un événement étranger à `schema_version` inconnue ailleurs dans le store n'affecte aucune résolution indépendante |
| C23 | Plusieurs chaînes distinctes vers le même principal, dont au moins une intégralement valide selon C1–C9 | La sortie de la chaîne valide s'applique (les autres chaînes, même corrompues ou cycliques, n'abaissent jamais ce résultat) |
| C24 | Aucune des chaînes menant au principal n'est intégralement valide et connue | `UNKNOWN` (ou `DENIED` si au moins une chaîne est intégralement connue et prouve positivement l'absence d'autorité, selon C11/C12) |
| C25 *(explainAction, I18)* | `ACTION_EXECUTED` de `sequence` S portant `decision_sequence >= S` (citation causalement impossible d'un point de décision futur ou simultané) | `UNKNOWN` (pour `execution.authorityAtDecision` ; `C25_FUTURE_DECISION_SEQUENCE`), quelle que soit par ailleurs l'autorité disponible au `decision_sequence` prétendu |
| C26 *(I19)* | `APPROVAL_GRANTED`/`APPROVAL_DENIED` dont l'`action_id` ou l'`approval_id` référencé n'existe pas dans le store canonique, ou y existe avec une `sequence` strictement supérieure à celle de la décision d'approbation elle-même (égalité tolérée — ne peut de toute façon jamais survenir via une ingestion réelle ; voir I19, « Note sur l'égalité de séquence ») | Traité comme si l'événement cité n'existait pas : la décision d'approbation est ignorée (comme C16) — `REQUIRES_APPROVAL` (C4) reste la sortie en l'absence de toute autre décision d'approbation valide. **Ne s'applique pas** à `SUBDELEGATION_CREATED.parent_delegation_id` : ce champ reste gouverné par C10 seul (A5 — voir I19 pour la distinction) |
| C27 *(I20)* | `ACTION_EXECUTED` dont l'`executed_by_principal_id` diffère du `requesting_principal_id` de l'`ACTION_REQUESTED` de même `action_id`, ou dont le maillon délégation terminal d'`authority_chain_ref` a un `grantee_principal_id` différent de son propre `executed_by_principal_id` | Exclue du calcul de `reste(D, S)` pour toute délégation D bornée par `total_budget` figurant dans sa chaîne — comptée comme si elle n'apparaissait pas dans `authority_chain_ref`. N'affecte aucune autre sortie que le montant du budget restant, qui alimente ensuite C9 normalement |
