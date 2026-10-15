# Synchronisation du planning entre appareils — mise en route (Firebase)

Le planning est stocké dans une base Firestore (offre gratuite Spark). Tous les
appareils qui ouvrent l'adresse du site lisent et écrivent le même document,
sans connexion ni code. Tout le planning tient dans un document `planning/main`
(un champ `json`).

## 1. Créer le projet
[console.firebase.google.com](https://console.firebase.google.com) → *Créer un projet* → nom `nounou`
(Google Analytics : désactivé).

## 2. Créer la base Firestore
*Build → Firestore Database → Créer une base de données* → région `eur3` ou
`europe-west`, mode **production**.

## 3. Règles d'accès
Onglet **Règles**, remplace tout par ceci puis **Publier** :

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /planning/{doc} {
      allow read, write: if true;
    }
  }
}
```

## 4. Récupérer les deux valeurs
*Paramètres du projet (engrenage) → Général* → **ID du projet**, puis
*Vos applications → </> (Web)* → enregistre une application web → copie `apiKey`.
Colle les deux dans [`js/config.js`](js/config.js).

## 5. Publier
`git add -A && git commit -m "Config Firebase" && git push` — le site se met à jour en ~1 min.

## Import des données existantes
Ouvre le site **d'abord sur l'appareil qui contient déjà le planning** : si le
document n'existe pas encore, son contenu local y est envoyé automatiquement.

## Comportement
- La note à côté du bouton PDF : *Synchro…*, *À jour à HH:MM*, *Hors ligne*.
- Actualisation à l'ouverture, au retour sur l'onglet, au retour du réseau, chaque minute.
- Hors ligne, la saisie est gardée localement et envoyée au retour du réseau.
- Deux appareils qui modifient en même temps : la dernière modification envoyée gagne.
- Tout détenteur de l'adresse peut lire et modifier le planning (pas de code).
