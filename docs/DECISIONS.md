# Journal de décisions (ADR léger)

Chaque décision contient son motif et sa condition de réouverture afin que le
projet ne dérive pas au gré des discussions.

## 2026-10-18 — Vendre une preuve de chaîne, pas un format de receipt

**Décision.** Authority ne crée pas un standard de reçu concurrent. Il fournit
une preuve d'autorité et un vérifieur pouvant se rattacher à des formats existants.

**Motif.** Des travaux SCITT/WIMSE et autres brouillons existent déjà. Le
produit n'a aucune chance s'il exige l'adoption d'un format concurrent.

**Réouvrir si.** Un test démontre qu'une information nécessaire ne peut pas
être représentée par les formats visés.

## 2026-10-18 — Démonstrateur MCP observé avant prospection large

**Décision.** Construire P1–P4, puis contacter les prospects. Pas de cloud ni
de dashboard.

**Motif.** Un composant de sécurité écrit par un inconnu doit être lisible et
vérifiable en quelques minutes. L'observation réduit le risque d'un faux positif.

**Réouvrir si.** Un prospect demande explicitement un autre mode, documenté
dans une décision spécifique.

## 2026-10-18 — V0 reste honnête sur son assurance

**Décision.** V0 conserve `ASSERTED_UNVERIFIED`. Les sorties ne prétendent pas
prouver l'identité ni la signature d'un émetteur.

**Motif.** Le moteur sait rejouer une chaîne ; il ne vérifie pas encore des clés.

**Réouvrir si.** Un modèle de confiance, de rotation de clés et de falsification
est conçu et testé.

## 2026-10-18 — Première offre : un outil, deux jalons de paiement

**Décision.** Tester `Authority Proof Starter` pour un outil à 990 EUR HT :
490 EUR au lancement et 500 EUR au passage du script d'acceptation.

**Motif.** Trois outils et dix jours à 990 EUR sont trop larges. Le paiement
uniquement après une PR publique ferait tout le travail gratuitement.

**Réouvrir si.** Deux offres sont acceptées, ou une objection récurrente est
documentée sur le prix, le paiement ou le périmètre.

## 2026-10-18 — Le cloud est différé

**Décision.** Pas de service hébergé avant une demande client explicite.

**Motif.** Le cloud introduit données clients, disponibilité, rétention,
sécurité, support et responsabilité sans démontrer le besoin du vérifieur.

**Réouvrir si.** Deux clients demandent explicitement de déléguer stockage et
vérification de leurs preuves.

## 2026-10-18 — Aucun `verify` avant digest des arguments et rejeu canonique

**Décision.** P1.5 est une précondition de P2 : l'empreinte doit couvrir les
arguments réels d'un outil et un export doit être rejoué avant de recevoir un
verdict.

**Motif.** L'empreinte actuelle ne couvre pas tous les arguments métier ; un
fichier JSON importé est aujourd'hui lu comme un export déjà canonique. Un
vérifieur construit sur ces deux hypothèses pourrait confirmer une action
différente de celle approuvée ou un journal modifié.

**Réouvrir si.** Jamais pour une intégration client. Seul le choix concret de
canonicalisation peut être revu, avec vecteurs de test et revue de sécurité.
