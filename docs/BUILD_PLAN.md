# Plan de construction — démonstrateur Authority Proof

Ce plan protège le noyau existant. Le moteur d'autorité reste pur et ne connaît
ni MCP, ni HTTP, ni un client particulier.

## État réellement disponible

| Élément | État | Emplacement |
|---|---|---|
| Événements canoniques et ingestion | présent | `src/domain`, `src/engine/ingest.ts` |
| Évaluation déterministe à un instant donné | présent | `src/engine/authorityAt.ts` |
| Explication historique d'une action | présent | `src/engine/explainAction.ts` |
| CLI `authority explain` | présent | `src/cli/authority.ts` |
| Démonstration achat / approbation / révocation | présent | `demo/run.ts` |
| Signatures et identité vérifiée | absent volontairement | assurance V0 = `ASSERTED_UNVERIFIED` |
| Serveur MCP et reçu exportable | absent | prochain incrément |
| Cloud, stockage mutualisé, dashboard | absent volontairement | hors périmètre |

## Architecture cible de la démo

```text
demo/mcp-server/
  tools.ts              trois outils métier fictifs
  authority-observer.ts adaptateur : enregistre la chaîne, sans bloquer
  scenarios.ts          délégation, approbation, révocation
  server.ts             frontière MCP/transport, sans logique d'autorité

src/engine/             moteur existant, pur : ne pas y mettre MCP
src/evidence/            projection d'un verdict vers une preuve exportable
src/cli/                 commande `authority verify` hors ligne
tests/evidence/          vecteurs de replay, un fichier par scénario
demo/fixtures/           exports JSON reproductibles de la démo
```

`src/evidence/` ne doit pas inventer une nouvelle norme. Il doit seulement
produire une projection versionnée de données déjà calculées par le moteur,
avec références aux événements nécessaires au replay.

## Incréments, dans cet ordre

### P0 — Documentation et garde-fous

Terminé quand `PROJECT.md`, `BUILD_PLAN.md`, `DECISIONS.md`, `WORKLOG.md` et
`GO_TO_MARKET.md` décrivent le même produit. Aucun code de produit supplémentaire.

### P1 — Scénario commercial local

Créer un scénario qui remplace l'achat générique par les trois outils de démo.
Il doit prouver au minimum :

- délégation valide ;
- action écrite autorisée en observation ;
- action nécessitant une approbation liée aux paramètres ;
- révocation ;
- action suivante refusée ou marquée contradictoire ;
- replay indépendant identique à la décision du moment.

Critère d'acceptation : une commande locale exécute les trois scénarios et
échoue si un verdict attendu change.

### P1.5 — Préconditions de sécurité du replay

P1 a montré les actions métier. Avant tout export, corriger deux limites du
noyau :

1. **Arguments complets.** L'empreinte d'action actuelle ne couvre que le
   montant, la devise et le destinataire. Une approbation de
   `change_role(user=42, role=viewer)` ne doit jamais couvrir
   `change_role(user=42, role=admin)`. Ajouter un `arguments_digest` calculé
   sur tous les arguments pertinents par une canonicalisation JSON standardisée
   et testée ; une exclusion doit être explicite et justifiée.
2. **Rejeu canonique.** Le vérifieur ne fait pas confiance à un tableau JSON
   présenté comme un journal. Il doit rejouer les drafts avec l'horloge
   enregistrée, vérifier séquences, événements et champs assignés, puis classer
   toute différence comme `indeterminate`.

Règles de compatibilité : chaque action doit porter une version de schéma
d'empreinte ; un bundle vérifié ne mélange pas des actions de schémas différents.
Il ne faut pas écrire une implémentation improvisée de canonicalisation dans la
logique métier : sélectionner une implémentation RFC 8785 maintenue, ou documenter
et tester une solution plus étroite avant tout usage de sécurité.

Critères d'acceptation :

- l'approbation `role=viewer` suivie de `role=admin` est contredite ;
- modifier un champ, enlever une révocation, créer un trou de séquence ou
  réutiliser un identifiant ne produit jamais `confirmed` ;
- le replay d'un journal émis par les scénarios existants restitue exactement
  le journal canonique ;
- V0 continue d'afficher `ASSERTED_UNVERIFIED`.

### P2 — Bundle d'événements et `authority verify`

Ajouter une commande distincte de `explain` :

```text
authority verify --evidence <path> --events <path> [--json]
```

Le bundle est un préfixe contigu d'événements canoniques, jusqu'à l'exécution
visée, avec son condensé et la version du moteur/empreinte. Il ne transporte
pas son propre verdict : `verify` le recalcule.

Sortie contractuelle : `confirmed`, `contradicted` ou `indeterminate`, un code
de raison stable, les identifiants d'événements concernés et le niveau
d'assurance. `confirmed` signifie « confirmé par rapport au journal affirmé et
rejoué ». La commande ne dit jamais « prouvé » tant que les événements ne sont
pas signés/identifiés.

Critère d'acceptation : dix vecteurs JSON minimum, dont délégation expirée,
révocation avant/après décision, plafond dépassé, approbation réutilisée,
arguments altérés, sous-délégation élargie, événement manquant et horloge
ambiguë. Un bundle suspect est `indeterminate`, jamais `contradicted`.

### P3 — Adaptateur MCP en observation

Ajouter le serveur MCP uniquement quand P1 et P2 sont verts. L'adaptateur :

1. reçoit une demande d'outil ;
2. calcule côté observateur le digest V2 sur un objet versionné contenant
   `server_id`, `tool_name`, `mapping_version` et les arguments réellement
   transmis au handler ; toute exclusion est écrite et testée ;
3. demande au moteur un verdict ;
4. journalise la décision et produit la preuve ;
5. laisse passer l'appel en observation, même en cas de verdict négatif ;
6. expose le résultat pour le replay.

Le mode bloquant doit rester non implémenté dans cette étape ou exiger une
activation explicite impossible à confondre avec l'observation.

### P4 — Démonstration et prospectus

Publier une vidéo de 90 secondes : délégation, action, révocation, seconde
action, `authority verify`. Publier aussi les vecteurs de test et une page qui
dit honnêtement : « événements assertés, non signés en V0 ».

### P5 — Premier client, pas de plateforme

Une intégration client reprend P3 dans un dépôt ouvert et avec un seul outil.
Chaque différence par rapport à la démo devient une décision écrite. Après deux
intégrations payées, seulement, évaluer ce qui mérite d'entrer dans le SDK.

## Limite connue de confidentialité

Un préfixe contigu empêche de retirer sélectivement une révocation, mais il peut
contenir des événements concernant d'autres actions. P2 est une démo, pas un
outil d'audit externe multi-client. Ne pas promettre un partage de bundle à un
tiers avant d'avoir conçu une preuve d'inclusion ou une autre stratégie de
minimisation des données.

## Contraintes de code

- aucun LLM, appel réseau ou lecture d'horloge dans `src/engine` ;
- aucune logique de décision dans la couche MCP ;
- aucun état client dans le moteur ;
- les données importées gardent leur `assurance_level` ;
- les représentations exportées sont versionnées et testées ;
- tout bug de sécurité devient un test de régression avant son correctif.

## Hors périmètre explicite jusqu'au premier paiement

Cloud, interface web, authentification utilisateur, base mutualisée,
signatures gérées par Authority, facturation, analyse IA des actions,
certification, conformité automatisée et intégrations propriétaires.
