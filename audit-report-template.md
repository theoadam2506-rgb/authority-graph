# Rapport d'audit ciblé — autorisation → exécution

> Gabarit à copier pour chaque mission. Les sections entre `[ ]` sont à
> remplacer. Ce gabarit suit `audit-methodology.md` et
> `evidence-schema.json` — chaque constat doit satisfaire ce schéma
> avant d'apparaître dans la section « Constats » ci-dessous.

---

**Client :** [nom du client]
**Mission :** [référence de mission / contrat]
**Date du rapport :** [AAAA-MM-JJ]
**Auteurs :** [personne(s) ayant réalisé l'audit]
**Relecteurs :** [personne(s) ayant réalisé la seconde relecture — voir §2]

---

## Avertissement

Ce rapport documente un **audit ciblé**, portant exclusivement sur le
périmètre décrit au §1 ci-dessous. Il **n'est ni une certification, ni
un audit de sécurité généraliste, ni une garantie de sécurité
globale**. L'absence de constat sur un flux non examiné ne signifie
pas son absence de vulnérabilité — seuls les flux effectivement
couverts par un test, tel que documenté ci-dessous, sont concernés par
une conclusion de ce rapport.

Les constats de statut « Confirmé » sont **défendables et
reproductibles** dans les conditions décrites : reproduits, dans un
environnement autorisé par écrit, avec une seconde relecture
humaine. Ce rapport n'emploie jamais le terme « opposable » et ne
promet à aucun moment l'absence de vulnérabilités, y compris dans le
périmètre couvert : seuls les flux et les mécanismes explicitement
testés sont statués ; tout le reste — code non couvert, chemins non
testés, environnements non examinés — reste hors de portée de ce
rapport.

---

## 1. Périmètre et version

| Champ | Valeur |
| --- | --- |
| Dépôt(s) audité(s) | [URL ou nom du dépôt] |
| Commit / version examinée | [hash de commit complet, ou tag de version] |
| Branche | [nom de branche] |
| Date de récupération du code | [AAAA-MM-JJ] |
| Environnement(s) autorisé(s) pour les tests | [liste des environnements, avec référence au document d'autorisation écrite — voir §2] |
| Flux inclus dans le périmètre | [liste explicite des flux/actions sensibles couverts] |
| Flux explicitement exclus | [liste, avec la raison de l'exclusion] |
| Systèmes tiers hors périmètre | [dépendances, fournisseurs externes non couverts] |

Toute divergence entre ce périmètre et le périmètre contractuel de la
mission doit être signalée avant publication du rapport, pas
découverte après.

## 2. Méthodologie

Cet audit suit `audit-methodology.md` (voir le document complet pour
les définitions de statut). Résumé du processus appliqué :

1. **Cadrage.** Le périmètre ci-dessus a été établi et l'autorisation
   écrite pour les environnements de test a été obtenue *avant* le
   début de l'analyse (référence : [document d'autorisation]).
2. **Repérage.** Signaux heuristiques automatisés (le cas échéant,
   Authority Tools — voir la mention `origineSignal` de chaque
   constat le cas échéant) et/ou revue manuelle directe.
3. **Triage humain.** Chaque signal a été relu par [rôle/personne] et
   classé : écarté (faux positif documenté séparément, hors de ce
   rapport), ou retenu comme constat candidat.
4. **Test.** Chaque constat candidat retenu pour confirmation a fait
   l'objet d'un test reproductible, dans un environnement autorisé
   (voir §1), avec entrée/sortie consignées.
5. **Seconde relecture.** Chaque constat visant le statut « Confirmé »
   a été revu par une seconde personne, distincte de celle ayant
   exécuté le test, qui a signé sa conclusion indépendamment.
6. **Rédaction.** Chaque constat est rapporté ci-dessous avec son
   schéma de preuve complet (`evidence-schema.json`) et son statut
   final, jamais reformulé au-delà de ce que la preuve établit.

Aucun outil automatisé utilisé au cours de cette mission n'a, à lui
seul, attribué de statut « Confirmé » : ce statut est toujours une
décision humaine documentée, conformément à `audit-methodology.md`.

## 3. Constats

> Dupliquer le bloc ci-dessous pour chaque constat. L'ordre suggéré
> est par sévérité perçue décroissante, puis par statut (Confirmé
> avant Probable avant Non vérifiable avant Signal à examiner).

### [ID du constat] — [titre court, factuel]

**Statut :** [Signal à examiner | Probable — non confirmé | Confirmé | Non vérifiable]

**Flux.** [description du flux ; acteur initiateur ; référence au
signal automatisé d'origine le cas échéant]

**Autorisation.** [mécanisme, version, émetteur, référence exacte
dans le code/la configuration]

**Attributs protégés.** [tableau ou liste : attribut, source
autorisée, source exécutée, comparaison documentée ou non]

**Point d'effet.** [référence fichier:ligne ou endpoint ; environnement
où il a été observé]

**Vérification.** [preuve examinée ; vérification humaine effectuée —
qui, comment ; état de la consommation/anti-rejeu]

**Test.** [type — automatisé ou manuel documenté ; environnement ;
référence de l'autorisation écrite couvrant ce test ; étapes ou script ;
entrée observée (expurgée) ; sortie observée (expurgée)]

**Résultat.** [observation directe ; reproductible ou non ; nombre de
reproductions]

**Contrôles compensatoires.** [recherchés ou non ; trouvés ou non ;
description ; exclusion documentée avec le client le cas échéant]

**Seconde relecture.** [relecteur ; date ; conclusion — uniquement si
statut = Confirmé]

**Limite.** [ce qui n'a pas été testé ; ce qui reste supposé ; bornes
de l'environnement de test — jamais vide]

---

## 4. Limites de la mission

[Cette section couvre les limites de la mission dans son ensemble,
distinctes du champ Limite propre à chaque constat.]

- **Périmètre non exhaustif.** Seuls les flux listés au §1 ont été
  examinés. Ce rapport ne dit rien des flux non listés.
- **Fenêtre temporelle.** L'audit reflète l'état du code au commit
  indiqué au §1 ; toute modification ultérieure du dépôt n'est pas
  couverte.
- **Environnements de test.** [préciser les environnements réellement
  disponibles et leurs différences connues avec la production, le cas
  échéant]
- **Dépendances tierces.** [préciser ce qui, dans les systèmes tiers
  utilisés par le périmètre, n'a pas pu être examiné]
- **Contraintes de mission.** [budget de temps, accès limités, ou
  toute autre contrainte ayant affecté la profondeur de l'examen]

## 5. Recommandations

> Une recommandation par constat « Confirmé » ou « Probable — non
> confirmé » au minimum ; une recommandation peut regrouper plusieurs
> constats de même nature.

| Priorité | Constat(s) concerné(s) | Recommandation | Statut du constat |
| --- | --- | --- | --- |
| [Haute/Moyenne/Basse] | [ID(s)] | [action concrète recommandée] | [statut] |

Les recommandations portent sur les constats de ce rapport
uniquement ; elles ne constituent pas un plan de sécurisation général
du système audité.

## 6. Statut final de chaque constat

| ID | Titre | Statut | Résumé en une phrase |
| --- | --- | --- | --- |
| [ID] | [titre] | [statut] | [résumé, sans détail technique sensible] |

---

## Rappel final

Ce rapport documente les résultats d'un **audit ciblé**, limité au
périmètre du §1, mené selon la méthodologie de preuve décrite dans
`audit-methodology.md`. Il ne constitue **ni une certification, ni une
garantie de sécurité globale**. Les constats « Confirmé » sont
défendables et reproductibles dans les conditions documentées ci-dessus
— ce rapport n'emploie à aucun moment le terme « opposable » et ne
promet, à aucun endroit, l'absence de vulnérabilités au-delà de ce qui
a été explicitement testé.
