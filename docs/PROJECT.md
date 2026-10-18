# Authority — cap du projet

## Une phrase

Authority permet à un éditeur de logiciel de **rejouer et vérifier, après une
action d'agent, la chaîne humaine de délégation, de limites et d'approbation
qui était valable à cet instant**.

## Le problème vendu

Un serveur MCP peut journaliser qu'un agent a supprimé un client ou émis un
avoir. Ce journal ne permet pas nécessairement à un tiers de vérifier :

- quel humain était la racine de l'autorité ;
- si chaque sous-délégation était plus étroite que la précédente ;
- si une approbation portait sur ces paramètres exacts ;
- si une révocation ou une expiration rendait l'action invalide à l'instant T.

Authority ne promet pas de rendre un agent sûr. Il rend une décision
d'autorité **rejouable, explicable et contestable**.

## Positionnement

Authority s'insère à côté des standards et brouillons existants de reçus et
d'identité d'agents. Il ne crée pas un nouveau format concurrent. Sa valeur
initiale est le moteur de vérification de l'**authority lineage** et une
intégration de démonstration observée.

## V0 commercial à démontrer

Un serveur MCP TypeScript de démonstration expose trois actions irréversibles :

1. supprimer un client ;
2. émettre un avoir plafonné ;
3. modifier un rôle.

Pour chacune, le démonstrateur émet une preuve liée à une chaîne :

`humain racine -> délégation -> sous-délégation -> approbation éventuelle -> action`.

Le vérifieur devra rendre l'un des trois verdicts : `confirmed`,
`contradicted` ou `indeterminate`, avec une raison lisible. `confirmed` voudra
toujours dire « confirmé par rapport au journal affirmé et rejoué », jamais
« identité prouvée ». Il fonctionnera hors ligne à partir des événements et de
la preuve fournis. Par défaut, le mode est **observation** : aucun outil MCP
n'est bloqué.

## Ce que nous ne construisons pas maintenant

- fournisseur d'identité, OAuth, gestion de jetons ou politique RBAC/ABAC ;
- gateway MCP générique ou proxy de toutes les actions ;
- service cloud, dashboard, multi-tenant ou facturation ;
- promesse de conformité légale ;
- signatures cryptographiques ou compatibilité formelle avec un draft tant
  qu'un plan d'interopérabilité testé n'existe pas.

## Première offre payante — hypothèse à tester

**Authority Proof Starter** : intégration en mode observation d'un outil MCP
risqué, avec preuve, vérifieur et tests de replay.

- client : éditeur SaaS B2B avec serveur MCP TypeScript officiel, ouvert ;
- périmètre : un outil d'écriture, jamais une revue globale de sécurité ;
- prix d'essai : 990 EUR HT ;
- paiement d'essai : 490 EUR au lancement, 500 EUR à l'exécution du script
  d'acceptation ;
- délai visé : cinq jours ouvrés ;
- extension : facturée outil par outil après réussite du premier.

Les prix, le canal et la demande sont des hypothèses commerciales ; ils ne sont
pas des faits de marché. Voir `docs/GO_TO_MARKET.md` et `docs/DECISIONS.md`.

## Décision de poursuite

Le projet continue vers une intégration pilote si le démonstrateur est publiable
et qu'un prospect accepte un périmètre écrit. Il ne passe pas au cloud avant que
des clients demandent explicitement de ne pas héberger leurs propres preuves.
