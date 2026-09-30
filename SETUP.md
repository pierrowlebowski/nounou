# Synchronisation du planning entre appareils — mise en route

Le planning est stocké dans une base Supabase (gratuite). Tous les appareils qui
ouvrent l'adresse du site lisent et écrivent dans la même base, sans connexion
ni code.

Ces étapes ne se font **qu'une seule fois**.

## 1. Créer un nouveau projet

[supabase.com](https://supabase.com) → *New project* → **Name** `nounou`,
**Region** `Central EU (Frankfurt)`.

## 2. Créer la table

Menu de gauche → **SQL Editor** → *New query* → colle et **Run** :

```sql
create table if not exists planning (
  id         text primary key,
  state      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table planning enable row level security;

create policy "lecture publique"     on planning for select using (true);
create policy "insertion publique"   on planning for insert with check (true);
create policy "modification publique" on planning for update using (true) with check (true);
```

## 3. Récupérer les deux valeurs

**Project Settings** → *Data API* → **Project URL**, et *API Keys* → clé
`anon` / `publishable`. Colle-les dans [`js/config.js`](js/config.js).

## 4. Publier

```bash
git add -A && git commit -m "Config Supabase" && git push
```

Puis active la publication du site (ex. GitHub Pages) et ouvre l'adresse sur le
téléphone.

## Import des données existantes

Ouvre le site **une fois sur l'appareil qui contient déjà le planning** : si la
base est vide, son contenu local y est envoyé automatiquement.
Ne l'ouvre pas d'abord sur un autre appareil vide, sinon la base sera initialisée vide.

## Comportement

- La note à côté du bouton PDF indique : *Synchro…*, *À jour à HH:MM*, *Hors ligne*.
- Actualisation à l'ouverture, au retour sur l'onglet, et toutes les minutes.
- Hors ligne, la saisie est gardée localement et envoyée au retour du réseau.
- Deux appareils qui modifient en même temps : la dernière modification envoyée gagne.
- Tout détenteur de l'adresse peut lire et modifier le planning (pas de code).
