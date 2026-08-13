defmodule Webby.Repo.Migrations.InitializeWebby do
  use Ecto.Migration

  def change do
    create table(:webby_meta, primary_key: false) do
      add :key, :string, primary_key: true
      add :value, :text, null: false
      timestamps(type: :utc_datetime)
    end
  end
end
