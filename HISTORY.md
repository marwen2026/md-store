# Historique du projet M&D Store

> Ce dépôt ne contient pas d'historique Git exploitable. Cette page présente donc
> l'historique fonctionnel reconstitué à partir de la version actuelle du projet.

## Version actuelle — 1.0

Date de référence : 1 octobre 2026

### Fonctionnalités disponibles

- Mise en place d'une boutique en ligne RTL avec une interface M&D Store.
- Ajout d'un panier côté client avec conservation locale via `localStorage`.
- Création d'un parcours de commande avec validation du stock côté serveur.
- Prise en charge des commandes avec paiement à la livraison.
- Confirmation de commande via WhatsApp lorsqu'un numéro valide est configuré.
- Recherche de produits et filtrage par catégories.
- Gestion des produits depuis l'administration :
  - création, modification et suppression logique ;
  - prix actuel, ancien prix, stock et prix de livraison ;
  - activation ou masquage d'un produit ;
  - ajout de plusieurs images et suppression d'images.
- Gestion des catégories.
- Gestion des commandes, des clients et des statuts :
  `new`, `confirmed`, `shipped`, `delivered` et `cancelled`.
- Création de shipments regroupant plusieurs commandes.
- Génération de factures PDF.
- Tableau de bord avec statistiques de produits, clients, commandes et ventes.
- Export des commandes depuis l'interface d'administration.
- Historique des changements de statut de chaque commande, y compris les
  commandes créées avant la mise à jour (initialisées comme événements existants).
- Journal des opérations API réussies effectuées par les administrateurs,
  consultable par le rôle admin.
- Consultation de l'historique et de la présentation du projet depuis
  l'administration.
- Authentification JWT et mots de passe hachés avec `bcryptjs`.
- Gestion des rôles `admin` et `manager`.
- Notifications temps réel de l'administration avec Server-Sent Events.
- Stockage PostgreSQL initialisé automatiquement au démarrage.
- Déploiement local ou Docker avec PostgreSQL et volumes persistants.

## Évolution fonctionnelle

### Étape 1 — Base de la boutique

Création du catalogue public, des catégories, du panier et du parcours de
commande.

### Étape 2 — Persistance et contrôle serveur

Migration vers PostgreSQL avec validation des stocks, conservation des clients
et enregistrement détaillé des commandes et de leurs articles.

### Étape 3 — Administration

Ajout de l'espace `/admin`, de l'authentification, des permissions, du CRUD des
produits et de la gestion des catégories.

### Étape 4 — Médias et documents

Ajout du téléchargement de plusieurs images par produit, de la suppression
d'images et de la génération de factures PDF.

### Étape 5 — Logistique et supervision

Ajout des statuts de commande, des shipments, des statistiques du tableau de
bord, des exports et des événements temps réel.

### Étape 6 — Conteneurisation

Ajout de Docker Compose, d'un healthcheck PostgreSQL et d'un healthcheck HTTP
pour l'application.

### Étape 7 — Historique et traçabilité

Ajout d'un historique persistant des statuts de commande, d'un journal des
actions d'administration, et de documents d'historique et de présentation
consultables dans le back-office.

## Prochaines évolutions possibles

- Ajouter des tests automatisés pour les commandes, les permissions et le stock.
- Ajouter une vraie journalisation applicative avec rotation des fichiers.
- Ajouter une procédure de migration de schéma versionnée.
