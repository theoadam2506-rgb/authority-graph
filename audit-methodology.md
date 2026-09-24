# Méthodologie de preuve — audit spécialisé « autorisation → exécution »

## Objet et périmètre

Ce document définit la méthodologie de preuve applicable à un audit
spécialisé portant sur les ruptures entre ce qu'une **autorisation**
couvre et ce qu'une **exécution** fait réellement, tel que ciblé par
Authority Tools et documenté par le journal Authority Graph
(`intention`, `autorisation`, `preuve`, `vérification`, `point
d'effet`, `comparaison`, `consommation`).

Il répond à une seule question : **à quelles conditions a-t-on le
droit d'écrire le mot « Confirmé » dans un rapport remis à un
client ?**

Ce document ne remplace ni ne modifie :

- le moteur d'analyse d'Authority Tools (heuristique, non exécutant,
  local) ;
- la spécification et les invariants d'Authority Graph
  (`SPEC.md`, `THREAT_MODEL.md`, `EVENT_MODEL.md`), qui décrivent un
  moteur d'autorisation déterministe distinct — cette méthodologie
  s'applique à l'audit de systèmes tiers en général, que ces systèmes
  soient ou non construits sur ce moteur.

Ce document ne définit pas non plus un processus de certification. Un
audit mené selon cette méthodologie reste **ciblé** sur un périmètre
convenu avec le client ; il ne constitue à aucun moment une garantie
d'absence de vulnérabilités ailleurs dans le système.

## Principe directeur

Un signal automatisé (règle heuristique, analyse statique, tout
outil) peut **orienter** une investigation. Il ne peut jamais, à lui
seul, **conclure** une investigation. Ce document existe précisément
pour combler l'écart entre les deux : ce qu'il faut ajouter à un
signal — preuve, test, relecture — avant qu'il devienne un constat
présentable à un client sous un statut donné.

> **Aucun outil automatisé ne peut, seul, attribuer le statut
> « Confirmé ».** Ce statut n'est jamais une sortie de programme ; il
> est toujours une décision humaine, documentée, engageant la
> responsabilité de qui la signe.

## Les quatre statuts

Chaque constat d'un rapport client porte exactement un de ces quatre
statuts. Aucun autre vocabulaire ne doit être utilisé dans un rapport
produit selon cette méthodologie.

### 1. Signal à examiner

**Définition.** Un signal produit par un outil automatisé (par
exemple un signal `ATG-00x` d'Authority Tools), pas encore relu par
un humain, ou relu mais sans qu'aucune des étapes de validation
ci-dessous n'ait commencé.

**Ce que cela implique.**
- Peut figurer dans une synthèse technique interne ou dans l'artefact
  brut d'un scan CI.
- Ne doit **jamais** apparaître comme un constat isolé dans un rapport
  client sans être accompagné de ce statut explicite et de la mention
  qu'aucune validation humaine n'a encore eu lieu.
- Porte toujours l'hypothèse et la limite générées par l'outil
  d'origine, telles quelles, sans reformulation qui leur ferait dire
  plus qu'elles ne disent.

### 2. Probable — non confirmé

**Définition.** Un signal qu'un humain a relu de bout en bout dans le
code source et jugé plausible — la lecture du chemin
autorisation → exécution suggère raisonnablement une rupture — mais
pour lequel au moins une des conditions du statut « Confirmé »
(section suivante) n'est pas remplie : pas de test reproductible, pas
d'environnement autorisé pour le rejouer, pas de seconde relecture,
ou tout autre manque.

**Ce que cela implique.**
- C'est le statut par défaut d'un constat sérieux qui n'a pas (encore,
  ou jamais, selon les contraintes de mission) fait l'objet d'un test.
- Le rapport doit indiquer explicitement **laquelle** des conditions
  de confirmation manque, pas seulement que le constat est
  « probable ». Un client doit pouvoir comprendre ce qui le sépare
  d'un « Confirmé » — et éventuellement le lever lui-même de son
  côté.
- N'affirme jamais une conséquence concrète non observée : le
  langage reste conditionnel (« pourrait permettre », jamais
  « permet »).

### 3. Confirmé

**Définition.** Un constat pour lequel **toutes**, sans exception,
les conditions suivantes sont réunies :

1. **Un test reproductible.** Un script automatisé ou une procédure
   manuelle documentée pas à pas, exécutée réellement (pas
   « aurait dû » ou « devrait »), dont l'entrée et la sortie
   observées sont consignées.
2. **Un environnement autorisé par écrit.** Le test a eu lieu dans un
   environnement pour lequel le client a donné une autorisation
   écrite couvrant explicitement ce type de test. Jamais en
   production sans mandat écrit séparé et distinct de l'autorisation
   générale de l'audit.
3. **Une divergence causale explicite entre l'action autorisée et
   l'action exécutée.** Le rapport énonce précisément quel attribut
   autorisé (montant, destinataire, ressource, rôle...) diverge de
   l'attribut réellement utilisé au point d'effet, et par quel
   mécanisme observé — pas une affirmation générale d'« absence de
   contrôle ».
4. **La prise en compte ou l'exclusion documentée des contrôles
   compensatoires.** Toute couche susceptible de neutraliser la
   divergence en amont ou en aval (passerelle, WAF, contrôle
   applicatif distinct, processus métier manuel) a été recherchée ;
   si un doute subsiste, la question a été posée explicitement au
   client et sa réponse consignée — jamais une absence supposée par
   défaut.
5. **Un résultat stable.** Le test a été rejoué plus d'une fois avec
   un résultat identique, ou l'éventuelle instabilité (dépendance à
   une condition de course, à un état transitoire...) est
   elle-même documentée dans le champ Limite plutôt que masquée.
6. **Une seconde relecture humaine.** Une personne distincte de celle
   ayant exécuté le test a revu l'intégralité du schéma de preuve
   (voir `evidence-schema.json`) et signé sa conclusion. Le nom, la
   date et la conclusion de cette relecture figurent dans le constat.
7. **Un champ Limite rempli.** Le constat énonce ce qui n'a pas été
   testé, ce qui reste supposé, et les bornes de l'environnement de
   test. Un champ Limite vide ou générique (« aucune limite connue »)
   invalide le statut « Confirmé » : cela signale que la frontière de
   la confiance n'a pas été établie, pas qu'elle n'existe pas.

**Ce que cela implique.**
- Ce statut engage la responsabilité de qui le signe. Il ne doit
  jamais être écrit par défaut, par optimisme, ou parce qu'un délai
  de mission presse.
- Le vocabulaire employé pour décrire un constat « Confirmé » reste
  **défendable et reproductible** — jamais « opposable » ni tout
  terme impliquant une valeur juridique ou une portée au-delà de ce
  que le test a réellement établi.
- Un constat « Confirmé » par le prestataire ne devient « Confirmé
  par le client » que si l'équipe du client, avec son propre accès,
  a elle-même rejoué le test et l'a validé de son côté — distinction
  à faire figurer explicitement si elle s'applique.

### 4. Non vérifiable

**Définition.** Un signal ou un constat probable pour lequel la
validation ne peut pas être menée à son terme dans les conditions de
la mission — pas parce que la divergence n'existe pas, mais parce que
les moyens de la vérifier manquent structurellement.

**Cas typiques.**
- Absence d'accès à un environnement où le test pourrait être rejoué
  sans risque pour le client.
- Dépendance à un système tiers hors périmètre contractuel
  (fournisseur externe, service que le client n'opère pas).
- Portée de l'action non résolue avec confiance par l'outil d'origine
  (cas explicitement prévu par Authority Tools : `presence:
  "non_verifiable"` sur un signal dont le gestionnaire n'a pas pu être
  résolu précisément — voir le journal Authority Tools).
- Contrainte de temps ou de budget de mission empêchant la
  reproduction, documentée comme telle plutôt que passée sous
  silence.

**Ce que cela implique.**
- Ce statut n'est ni « Probable » ni « écarté » : c'est une
  affirmation honnête d'incertitude structurelle, pas un jugement sur
  la réalité de la divergence.
- Le rapport doit indiquer ce qu'il faudrait, concrètement, pour lever
  la non-vérifiabilité (accès à tel environnement, autorisation pour
  tel test) — de sorte que le client puisse, s'il le souhaite,
  fournir ce qui manque.

## Table récapitulative

| Statut | Origine | Test rejoué | Divergence causale établie | Deuxième relecture | Peut figurer seul dans un rapport client |
| --- | --- | --- | --- | --- | --- |
| Signal à examiner | Outil automatisé | Non | Non | Non | Uniquement avec avertissement explicite |
| Probable — non confirmé | Relecture humaine | Non, ou partiellement | Plausible, non établie | Non requise | Oui, avec la condition manquante précisée |
| Confirmé | Les 7 conditions ci-dessus | Oui | Oui | Oui | Oui |
| Non vérifiable | Signal ou relecture bloqué structurellement | Impossible dans la mission | Sans objet | Sans objet | Oui, avec ce qui manque pour lever le blocage |

## Relation avec les autres documents

- **`evidence-schema.json`** encode, sous forme de schéma JSON, le
  contenu minimal obligatoire d'un constat et les champs
  supplémentaires exigés spécifiquement quand `statut` vaut
  `"Confirmé"` — de sorte que les sept conditions ci-dessus soient
  vérifiables mécaniquement, pas seulement rappelées en prose.
- **`audit-report-template.md`** est le gabarit de rapport client qui
  consomme ce schéma et cette méthodologie.

## Ce que cette méthodologie ne fait pas

- Elle ne transforme pas un signal heuristique en preuve : elle décrit
  ce qu'il faut ajouter à un signal pour qu'il en devienne une.
- Elle ne garantit l'absence de vulnérabilité nulle part : un audit
  mené selon cette méthodologie reste borné au périmètre convenu, et
  seuls les flux effectivement examinés sont couverts par un
  quelconque statut.
- Elle ne remplace pas un audit de sécurité généraliste, une
  certification, ou une revue de conformité réglementaire.
