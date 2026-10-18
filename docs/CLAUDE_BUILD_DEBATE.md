# Prompt Claude — revue de construction Authority

Copier ce texte dans Claude après lecture de `README.md`, `SPEC.md`,
`EVENT_MODEL.md`, `THREAT_MODEL.md` et du dossier `docs/`.

---

Tu joues le rôle d'un reviewer sécurité et mainteneur open source hostile mais
constructif. Nous allons construire Authority, un moteur TypeScript
déterministe qui rejoue la chaîne humaine d'autorité derrière une action d'agent.

État actuel : le moteur gère une chaîne humain racine -> délégation ->
sous-délégation -> approbation liée aux paramètres -> action, avec révocation,
expiration, budgets et replay historique. V0 déclare explicitement
`ASSERTED_UNVERIFIED` : aucune signature ni identité cryptographique n'existe.

Objectif des sept prochains jours : produire un démonstrateur MCP TypeScript en
mode observation pour trois outils risqués, plus une commande `authority verify`
hors ligne qui retourne `confirmed`, `contradicted` ou `indeterminate`.

Contraintes :

- ne pas créer un IAM, un policy engine, un gateway MCP ni un cloud ;
- ne pas créer un format de receipt concurrent ;
- ne pas déplacer de logique d'autorité hors du moteur pur ;
- ne jamais prétendre qu'une assertion non signée est une preuve d'identité ;
- le premier client doit pouvoir lire le code et les tests en moins de dix minutes.

Je veux que tu attaques le plan `docs/BUILD_PLAN.md` point par point :

1. quels fichiers et types précis créer ou modifier en P1, P2 et P3 ;
2. quelle structure minimale doit avoir une preuve exportable sans inventer un standard ;
3. quels dix vecteurs de tests doivent exister ;
4. où le mode observation peut devenir dangereux ou trompeur ;
5. quelles propriétés doivent être testées avant toute pull request cliente ;
6. quel élément du noyau existant rend ce plan irréaliste ou incomplet ;
7. quel morceau doit être supprimé pour tenir en sept jours.

Réponds sous la forme : `KILL`, `KEEP`, `CHANGE`, puis une liste de modifications
concrètes. Ne propose ni UI, ni cloud, ni OAuth, ni nouvelle norme.
