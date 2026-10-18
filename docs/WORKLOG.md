# Journal de travail

## 2026-10-18 — Recentrage vers le premier paiement

### Fait aujourd'hui

- Le dépôt contient déjà le noyau déterministe : événements, délégation,
  approbation liée aux paramètres, révocation, explication historique et CLI.
- La documentation du noyau indique que V0 est `ASSERTED_UNVERIFIED` : aucune
  signature ou identité vérifiée n'est présente.
- Dans l'environnement local autorisé, `npm run typecheck` et `npm test`
  passent le 2026-10-18 : 12 fichiers et 108 tests verts. Le blocage précédent
  venait de la restriction d'environnement sur les canaux temporaires de Node,
  pas du dépôt.

### Décision produit

Le prochain résultat n'est ni un cloud ni une API SaaS. C'est un démonstrateur
MCP observable, une commande de vérification hors ligne et des vecteurs de tests.

### Avancement P1

- `demo/authority-proof.ts` crée trois actions métier : suppression de client,
  émission d'avoir avec approbation liée aux paramètres, et changement de rôle
  suivi d'une révocation.
- `npm run demo:proof` est la commande d'acceptation locale de ce scénario.
- `npm run demo:proof` a terminé avec succès le 2026-10-18 : les trois
  scénarios et leurs assertions ont passé.
- Ce n'est pas encore un transport MCP, une preuve exportable ni un vérifieur
  indépendant : ces éléments restent P2 et P3.
- Le premier essai a montré que le motif d'un refus peut être masqué par une
  délégation sans rapport appartenant au même agent ; le scénario utilise donc
  un `admin-agent` distinct pour isoler la démonstration de révocation. Le choix
  du meilleur motif de refus mérite une décision dédiée avant P2.

### Revue externe de construction

Une revue du 2026-10-18 confirme le cap, mais impose P1.5 avant P2 : le digest
d'action actuel ne lie pas tous les arguments d'un outil, et un export JSON ne
peut pas être traité comme canonique sans rejeu. Le plan a été mis à jour dans
`BUILD_PLAN.md` et la décision est consignée dans `DECISIONS.md`.

### Avancement P1.5

- `src/domain/canonicalJson.ts` canonicalise les arguments via RFC 8785 et
  conserve uniquement leur SHA-256.
- `ActionParameters.arguments_digest` change l'empreinte d'une nouvelle action
  sans modifier les empreintes historiques sans digest. Le schéma V2 est
  explicite et sa version entre dans le préimage : aucun digest ne peut être
  interprété par erreur comme V1.
- `src/engine/replayCanonical.ts` ré-ingère un flux canonique afin de vérifier
  séquences, champs attribués et monotonie de l'horloge de confiance.
- Les tests dédiés couvrent ordre des clés, modification d'argument, valeurs
  JSON interdites, replay valide et séquence falsifiée.
- Quatre reproductions adversariales auparavant rouges sont vertes : grant sans
  demande, débit par exécution usurpée, consommation d'approbation détachée et
  décision future.

### Prochaine action de code

Concevoir P2 : bundle contigu, digest du bundle, schéma strict et commande
`authority verify`. Ne pas commencer l'adaptateur MCP avant que le bundle et
ses vecteurs de falsification soient validés.

### Risques ouverts

- aucun modèle de signature ou de gestion des clés n'existe ;
- aucune interopérabilité SCITT/WIMSE testée n'existe ;
- l'existence d'un client prêt à payer reste une hypothèse commerciale.
